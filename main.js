"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const config = require("./config");

const app = express();
const server = http.createServer(app);

const BASE_URL = config.qwen.baseUrl;

// ============== SESSION STATE ==============

const session = {
  userId: "",
  userName: "Guest",
  initialized: false,
  initializing: false,
  features: {
    thinking: true,
    autoSearch: true,
    thinkingMode: "Thinking",    // "Thinking" | "Fast"
    researchMode: "advance",      // "normal" | "advance"
    persistHistory: false,
    threadingEnabled: false, // false=always null; true=auto-thread
    includeThinkingInOutput: false, // stream thinking_summary content as <thinking> blocks
  },
};

// ============== PER-SESSION CONVERSATION STATE ==============

const sessions = new Map(); // sessionId -> { chatId, parentId, messages, lastUsed }
const SESSION_TTL = 30 * 60 * 1000;

function getOrCreateSession(req) {
  const sessionId = req.headers["x-session-id"] || "default";
  const fresh = req.headers["x-fresh-session"] === "true";

  if (fresh || !sessions.has(sessionId)) {
    sessions.set(sessionId, {
      chatId: null,        // created lazily on first request
      parentId: null,      // last message's fid (for threading)
      messages: [],
      lastUsed: Date.now(),
    });
  }

  const s = sessions.get(sessionId);
  s.lastUsed = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ============== MIDDLEWARE ==============

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Session-Id, X-Fresh-Session, anthropic-version, anthropic-beta");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "50mb" }));

function authMiddleware(req, res, next) {
  if (!config.auth.enabled) return next();
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  const apiKey = req.headers["x-api-key"];
  const provided = token || apiKey;
  if (provided !== config.auth.token) {
    return res.status(401).json({
      type: "error",
      error: { type: "authentication_error", message: "Invalid or missing authentication token" },
    });
  }
  next();
}

// ============== UTILITY ==============

function generateId() {
  return crypto.randomUUID();
}

function shortId() {
  return crypto.randomBytes(12).toString("hex");
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil((text || "").length / 4);
}

function qwenHeaders(extraHeaders = {}) {
  return {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Cookie": `token=${config.qwen.token}`,
    "Authorization": `Bearer ${config.qwen.token}`,
    ...extraHeaders,
  };
}

// ============== QWEN CHAT CREATION ==============

async function createQwenChat(model) {
  const body = JSON.stringify({
    title: "New Chat",
    models: [model || config.qwen.defaultModel],
    chat_mode: "normal",
    chat_type: "t2t",
    timestamp: Date.now(),
    project_id: "",
  });

  const res = await fetch(`${BASE_URL}/api/v2/chats/new`, {
    method: "POST",
    headers: qwenHeaders(),
    body,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Qwen chat creation failed ${res.status}: ${txt}`);
  }

  const data = await res.json();
  if (!data.success || !data.data?.id) {
    throw new Error(`Qwen chat creation bad response: ${JSON.stringify(data)}`);
  }

  return data.data.id;
}

// ============== INITIALIZE (just validate token) ==============

async function initializeSession() {
  if (session.initializing) {
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!session.initializing) { clearInterval(check); resolve(); }
      }, 100);
    });
    return;
  }

  session.initializing = true;
  console.log("[Session] Validating Qwen token...");

  try {
    // Decode userId from JWT (no network needed)
    const parts = config.qwen.token.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1] + "==", "base64").toString("utf8"));
        session.userId = payload.id || "";
        console.log(`[Session] Token user ID: ${session.userId.substring(0, 8)}...`);
      } catch (_) {}
    }

    // Quick ping to verify token is valid
    const res = await fetch(`${BASE_URL}/api/v2/configs/`, {
      headers: qwenHeaders(),
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401) {
      throw new Error("Qwen token is invalid or expired (401)");
    }

    session.initialized = true;
    console.log("[Session] Qwen token validated OK.");
  } catch (e) {
    console.error("[Session] Init error:", e.message);
    session.initialized = false;
    throw e;
  } finally {
    session.initializing = false;
  }
}

// ============== MESSAGE CONVERSION ==============

// Convert Anthropic/OpenAI messages to flat text for logging (not sent to Qwen)
function messagesToText(messages) {
  if (!Array.isArray(messages)) return String(messages || "");
  return messages.map(m => {
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(b => b.type === "text" || b.type === "tool_result" || typeof b === "string")
        .map(b => {
          if (typeof b === "string") return b;
          if (b.type === "tool_result") {
            const inner = Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : (b.content || "");
            return `[Tool Result]: ${inner}`;
          }
          return b.text || "";
        })
        .join("\n");
    }
    return String(content || "");
  }).join("\n\n");
}

// Convert Anthropic messages + system → Qwen messages array
// Qwen expects: role, content (string), plus our extra metadata fields
function buildQwenMessages(messages, system, model, opts = {}) {
  const {
    thinking = session.features.thinking,
    thinkingMode = session.features.thinkingMode,
    autoSearch = session.features.autoSearch,
    researchMode = session.features.researchMode,
  } = opts;

  const qwenMsgs = [];
  const qwenModel = model || config.qwen.defaultModel;

  // Extract system text
  const systemText = system
    ? (typeof system === "string"
        ? system
        : Array.isArray(system)
          ? system.map(b => b.text || "").join("\n")
          : String(system))
    : "";

  const featureConfig = {
    thinking_enabled: thinking,
    output_schema: "phase",
    research_mode: researchMode,
    auto_thinking: false,
    thinking_mode: thinkingMode,
    thinking_format: "summary",
    auto_search: autoSearch,
  };

  let isFirst = true;

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "tool_result") {
          const inner = Array.isArray(block.content)
            ? block.content.map(c => c.text || "").join("\n")
            : (block.content || "");
          parts.push(`[Tool Result]: ${inner}`);
        } else if (block.type === "tool_use") {
          parts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`);
        } else if (block.text) {
          parts.push(block.text);
        }
      }
      content = parts.join("\n");
    } else {
      content = String(msg.content || "");
    }

    // Inject system prompt into first user message
    if (isFirst && role === "user" && systemText.trim()) {
      content = `${systemText}\n\n${content}`;
      isFirst = false;
    } else if (role === "user") {
      isFirst = false;
    }

    const fid = generateId();
    const subChatType = "t2t";

    qwenMsgs.push({
      fid: null,
      parentId: null,
      childrenIds: [],
      role,
      content,
      user_action: "chat",
      files: [],
      timestamp: Math.floor(Date.now() / 1000),
      models: [qwenModel],
      chat_type: "t2t",
      feature_config: featureConfig,
      extra: { meta: { subChatType } },
      sub_chat_type: subChatType,
      parent_id: null,
    });
  }

  return qwenMsgs;
}

// ============== SEND TO QWEN (streaming generator) ==============

async function* sendToQwen(qwenMessages, opts = {}) {
  const {
    model = config.qwen.defaultModel,
    chatId: providedChatId = null,
    reqSession = null,
    includeThinking = session.features.includeThinkingInOutput,
  } = opts;

  if (!session.initialized) await initializeSession();

  // Get or create chatId for this session
  let chatId = providedChatId;
  if (!chatId && reqSession) {
    if (!reqSession.chatId) {
      reqSession.chatId = await createQwenChat(model);
      console.log(`[Chat] Created new Qwen chat: ${reqSession.chatId}`);
    }
    chatId = reqSession.chatId;
  }
  if (!chatId) {
    chatId = await createQwenChat(model);
  }

  const lastMsg = qwenMessages[qwenMessages.length - 1];
  const parentId = (config.qwen.threadingEnabled !== false && session.features.threadingEnabled !== false)
    ? ((reqSession?.parentId) || null)
    : null; // threadingEnabled=false: always null

  // Update parent_id on the last message
  if (lastMsg) {
    lastMsg.parent_id = parentId;
    lastMsg.parentId = parentId;
  }

  const body = JSON.stringify({
    stream: true,
    version: "2.1",
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: parentId,
    messages: qwenMessages,
    timestamp: Math.floor(Date.now() / 1000),
  });

  if (config.logging.level === "debug") {
    console.log("[DEBUG] Qwen request body:", body);
  }

  const url = `${BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`;
  const headers = qwenHeaders({ "Referer": `${BASE_URL}/c/${chatId}` });

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw new Error(`Qwen connection error: ${e.message}`);
  }

  if (res.status === 401) {
    session.initialized = false;
    throw new Error("Qwen token expired or invalid (401). Update QWEN_TOKEN in config.");
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Qwen error ${res.status}: ${errText}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Qwen rejected request (200 JSON): ${errBody}`);
  }

  if (config.logging.level === "debug") {
    console.log(`[Qwen] Response status=${res.status} content-type=${ct}`);
  }

  if (!res.body) {
    throw new Error("Qwen returned response with null body — cannot stream");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = null;
  let inThinkingBlock = false;

  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();

        if (config.logging.level === "debug") {
          console.log("[RAW SSE]", JSON.stringify(trimmed));
        }

        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") return;

        try {
          const json = JSON.parse(dataStr);

          if (json["response.created"]) {
            responseId = json["response.created"].response_id;
            if (reqSession && json["response.created"].parent_id) {
              reqSession.parentId = json["response.created"].response_id;
            }
            console.log(`[Qwen] response.created — chatId=${json["response.created"].chat_id?.substring(0,8)} responseId=${responseId?.substring(0,8)}`);
            continue;
          }

        const choice = json.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        const phase = delta?.phase;
        const status = delta?.status;
        const content = delta?.content;

        if (phase === "thinking_summary") {
          if (includeThinking) {
            if (status === "typing") {
              const thoughtLines = delta?.extra?.summary_thought?.content;
              if (Array.isArray(thoughtLines) && thoughtLines.length > 0) {
                if (!inThinkingBlock) {
                  yield "<thinking>\n";
                  inThinkingBlock = true;
                }
                yield thoughtLines.join("\n");
              }
            } else if (status === "finished" && inThinkingBlock) {
              yield "\n</thinking>\n\n";
              inThinkingBlock = false;
            }
          }
          continue;
        }

        if (inThinkingBlock && phase !== "thinking_summary") {
          if (includeThinking) yield "\n</thinking>\n\n";
          inThinkingBlock = false;
        }

        if (content !== undefined && content !== null && content !== "") {
          yield String(content);
        }

      } catch (parseErr) {
        if (config.logging.level === "debug") {
          console.warn("[SSE parse error]", parseErr.message);
        }
      }
    }
    }
  } finally {
    reader.releaseLock();
  }

  if (buffer.trim().startsWith("data: ")) {
    const dataStr = buffer.trim().slice(6);
    if (dataStr !== "[DONE]") {
      try {
        const json = JSON.parse(dataStr);
        const c = json.choices?.[0]?.delta?.content;
        if (c) yield String(c);
      } catch (_) {}
    }
  }

  if (inThinkingBlock && opts.includeThinking) yield "\n</thinking>\n\n";
}

// ============== FORMAT HELPERS ==============

function generateShortId() {
  return shortId().substring(0, 24);
}

function estimateTokensFromContent(content) {
  return estimateTokens(typeof content === "string" ? content : JSON.stringify(content));
}

function parseToolCalls(content) {
  const toolCalls = [];
  if (!config.parseTool || !content) return toolCalls;

  const mdJsonPattern = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?```/gi;
  let match;
  while ((match = mdJsonPattern.exec(content)) !== null) {
    try {
      const j = JSON.parse(match[1]);
      if (j.tool_calls && Array.isArray(j.tool_calls)) {
        for (const tc of j.tool_calls) {
          toolCalls.push({
            id: tc.id || `call_${generateShortId()}`,
            type: "function",
            function: {
              name: tc.function?.name || tc.name,
              arguments: typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
            },
          });
        }
      } else if (j.name || j.function) {
        toolCalls.push({
          id: `call_${generateShortId()}`,
          type: "function",
          function: {
            name: j.name || j.function,
            arguments: typeof j.arguments === "string" ? j.arguments : JSON.stringify(j.arguments || {}),
          },
        });
      }
    } catch (_) {}
  }

  return toolCalls;
}

function removeToolCallsFromContent(content) {
  let c = content || "";
  c = c.replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?"(?:name|tool_calls)"[\s\S]*?\}\s*\n?```/gi, "");
  return c.replace(/\n{3,}/g, "\n\n").trim();
}

function toolCallsToAnthropicBlocks(toolCalls) {
  return toolCalls.map(tc => ({
    type: "tool_use",
    id: tc.id || `toolu_${generateShortId()}`,
    name: tc.function.name,
    input: (() => {
      try { return JSON.parse(tc.function.arguments); }
      catch (_) { return { raw: tc.function.arguments }; }
    })(),
  }));
}

function formatAnthropicResponse(fullContent, model, requestId) {
  const toolCalls = parseToolCalls(fullContent);
  const cleanText = toolCalls.length > 0 ? removeToolCallsFromContent(fullContent) : fullContent;
  const contentBlocks = [];

  if (cleanText && cleanText.trim()) contentBlocks.push({ type: "text", text: cleanText });
  if (toolCalls.length > 0) contentBlocks.push(...toolCallsToAnthropicBlocks(toolCalls));
  if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

  return {
    id: `msg_${requestId}`,
    type: "message",
    role: "assistant",
    model: model || config.qwen.defaultModel,
    content: contentBlocks,
    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(fullContent),
      output_tokens: estimateTokens(fullContent),
    },
  };
}

function formatAnthropicError(message, type = "api_error") {
  return { type: "error", error: { type, message } };
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function formatOpenAIResponse(rawContent, model, requestId, stream = false, fullContent = null) {
  const timestamp = Math.floor(Date.now() / 1000);

  if (stream) {
    if (!fullContent) {
      return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model || config.qwen.defaultModel,
        choices: [{ index: 0, delta: { content: rawContent }, finish_reason: null }],
      };
    }
    const toolCalls = parseToolCalls(fullContent);
    if (toolCalls.length > 0) {
      return {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: timestamp,
        model: model || config.qwen.defaultModel,
        choices: [{
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, idx) => ({
              index: idx, id: tc.id, type: "function",
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          },
          finish_reason: "tool_calls",
        }],
      };
    }
    return {
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      created: timestamp,
      model: model || config.qwen.defaultModel,
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    };
  }

  const toolCalls = parseToolCalls(rawContent);
  const cleanContent = toolCalls.length > 0 ? removeToolCallsFromContent(rawContent) : rawContent;
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: timestamp,
    model: model || config.qwen.defaultModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: toolCalls.length > 0 ? (cleanContent || null) : cleanContent,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: estimateTokens(rawContent),
      completion_tokens: estimateTokens(rawContent),
      total_tokens: estimateTokens(rawContent) * 2,
    },
  };
}

function formatOpenAIError(message, type = "api_error") {
  return { error: { message, type, code: null, param: null } };
}

// ============== MODEL MAPPING ==============

function mapToQwenModel(modelName) {
  const m = (modelName || "").toLowerCase();
  if (m.includes("opus") || m.includes("max")) return "qwen3.6-max-preview";
  if (m.includes("haiku") || m.includes("flash")) return "qwen3.5-flash";
  if (m.includes("coder") || m.includes("code")) return "qwen3-coder-plus";
  if (m.includes("qwen")) return modelName; // pass qwen models through directly
  return config.qwen.defaultModel; // default: qwen3.6-plus
}

// ============== DASHBOARD HTML ==============

function getDashboardHTML(host) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qwen Bridge</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%);
      min-height: 100vh; color: #e0e0e0; padding: 20px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    .header {
      text-align: center; padding: 40px 20px;
      background: rgba(255,255,255,0.05); border-radius: 16px;
      margin-bottom: 30px; border: 1px solid rgba(255,255,255,0.1);
    }
    .header h1 {
      font-size: 2.5rem;
      background: linear-gradient(135deg, #56ccf2, #2f80ed);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      margin-bottom: 10px;
    }
    .header p { color: #888; font-size: 1.1rem; }
    .badges { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 0.8rem; font-weight: 700; }
    .badge-green { background: #22c55e; color: #000; }
    .badge-blue  { background: #2f80ed; color: #fff; }
    .badge-purple{ background: #a855f7; color: #fff; }
    .badge-orange{ background: #f59e0b; color: #000; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .card {
      background: rgba(255,255,255,0.05); border-radius: 12px;
      padding: 24px; border: 1px solid rgba(255,255,255,0.1);
    }
    .card h2 { color: #56ccf2; margin-bottom: 16px; font-size: 1.2rem; }
    .stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .stat { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; }
    .stat .label { color: #888; font-size: 0.85rem; }
    .stat .value { color: #56ccf2; font-weight: 600; font-size: 1.3rem; margin-top: 4px; }
    .code-block {
      background: #0d1117; border-radius: 8px; padding: 16px; overflow-x: auto;
      font-family: 'Monaco', 'Menlo', monospace; font-size: 0.82rem;
      border: 1px solid #30363d; margin: 12px 0;
    }
    .code-block code { color: #c9d1d9; white-space: pre-wrap; }
    .endpoint { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; margin-bottom: 8px; }
    .method { display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; margin-right: 8px; }
    .method.get { background: #22c55e; color: #000; }
    .method.post { background: #2f80ed; color: #fff; }
    .path { font-family: monospace; color: #e0e0e0; }
    .desc { color: #888; font-size: 0.85rem; margin-top: 4px; }
    .section-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #a855f7; margin: 16px 0 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Qwen Bridge</h1>
      <p>Proxy for chat.qwen.ai — OpenAI & Anthropic compatible</p>
      <div class="badges">
        <span class="badge badge-green">⚡ Direct Mode</span>
        <span class="badge badge-blue">OpenAI Compatible</span>
        <span class="badge badge-purple">Anthropic Compatible</span>
        <span class="badge badge-orange">Qwen Native</span>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Status</h2>
        <div class="stat-grid">
          <div class="stat"><div class="label">Token</div><div class="value" id="tokenStatus">...</div></div>
          <div class="stat"><div class="label">User ID</div><div class="value" id="userId" style="font-size:0.8rem">...</div></div>
          <div class="stat"><div class="label">Sessions</div><div class="value" id="sessions">0</div></div>
          <div class="stat"><div class="label">Chat Type</div><div class="value">t2t</div></div>
        </div>
      </div>

      <div class="card">
        <h2>Features</h2>
        <div class="stat-grid">
          <div class="stat"><div class="label">Thinking</div><div class="value" id="featThinking">ON</div></div>
          <div class="stat"><div class="label">Auto Search</div><div class="value" id="featSearch">ON</div></div>
          <div class="stat"><div class="label">Mode</div><div class="value" id="featThinkMode">Thinking</div></div>
          <div class="stat"><div class="label">Research</div><div class="value" id="featResearch">normal</div></div>
        </div>
      </div>

      <div class="card" style="grid-column: span 2;">
        <h2>API Endpoints</h2>

        <div class="section-label">Anthropic-Compatible (Claude Code)</div>
        <div class="endpoint">
          <span class="method post">POST</span><span class="path">/v1/messages</span>
          <div class="desc">Anthropic Messages API — streaming SSE + tool_use. Set ANTHROPIC_BASE_URL=http://${host}</div>
        </div>
        <div class="endpoint">
          <span class="method get">GET</span><span class="path">/v1/models</span>
          <div class="desc">Lists Qwen models (fetched live from chat.qwen.ai) + Anthropic aliases</div>
        </div>

        <div class="section-label">OpenAI-Compatible</div>
        <div class="endpoint">
          <span class="method post">POST</span><span class="path">/v1/chat/completions</span>
          <div class="desc">OpenAI chat endpoint. Supports streaming.</div>
        </div>

        <div class="section-label">Management</div>
        <div class="endpoint">
          <span class="method post">POST</span><span class="path">/features</span>
          <div class="desc">Toggle: thinking, autoSearch, thinkingMode, researchMode, persistHistory, includeThinkingInOutput</div>
        </div>
        <div class="endpoint">
          <span class="method post">POST</span><span class="path">/admin/session/clear</span>
          <div class="desc">Clear all session histories and chat IDs</div>
        </div>
      </div>

      <div class="card" style="grid-column: span 2;">
        <h2>Claude Code Setup</h2>
        <div class="code-block"><code># PowerShell / CMD
set ANTHROPIC_BASE_URL=http://localhost:${config.server.port}
set ANTHROPIC_AUTH_TOKEN=${config.auth.token}
set ANTHROPIC_API_KEY=
claude

# ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:${config.server.port}",
    "ANTHROPIC_AUTH_TOKEN": "${config.auth.token}",
    "ANTHROPIC_API_KEY": ""
  }
}</code></div>
      </div>
    </div>
  </div>

  <script>
    async function updateStatus() {
      try {
        const r = await fetch('/status');
        const d = await r.json();
        document.getElementById('tokenStatus').textContent = d.tokenValid ? '✓ Valid' : '✗ Invalid';
        document.getElementById('userId').textContent = d.userId || '-';
        document.getElementById('sessions').textContent = d.activeSessions;
        document.getElementById('featThinking').textContent = d.features?.thinking ? 'ON' : 'OFF';
        document.getElementById('featSearch').textContent = d.features?.autoSearch ? 'ON' : 'OFF';
        document.getElementById('featThinkMode').textContent = d.features?.thinkingMode || '-';
        document.getElementById('featResearch').textContent = d.features?.researchMode || '-';
      } catch(e) { console.error(e); }
    }
    updateStatus();
    setInterval(updateStatus, 4000);
  </script>
</body>
</html>`;
}

// ============== ROUTES ==============

app.get("/", (req, res) => {
  const host = req.headers.host || `localhost:${config.server.port}`;
  res.send(getDashboardHTML(host));
});

app.get("/status", (req, res) => {
  res.json({
    tokenValid: session.initialized,
    userId: session.userId ? session.userId.substring(0, 8) + "..." : null,
    activeSessions: sessions.size,
    features: session.features,
    parseTool: config.parseTool,
  });
});

// ============================================================
// ── ANTHROPIC-COMPATIBLE /v1/messages ───────────────────────
// ============================================================

app.post("/v1/messages", authMiddleware, async (req, res) => {
  const {
    model: reqModel = config.qwen.defaultModel,
    messages,
    system,
    stream = false,
  } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json(formatAnthropicError("messages is required and must be an array", "invalid_request_error"));
  }

  const qwenModel = mapToQwenModel(reqModel);
  const reqSession = getOrCreateSession(req);
  const requestId = shortId();

  const qwenMsgs = buildQwenMessages(messages, system, qwenModel);

  const opts = {
    model: qwenModel,
    reqSession,
    includeThinking: session.features.includeThinkingInOutput,
  };

  // ── STREAMING ──
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const msgId = `msg_${requestId}`;
    const inputTokens = estimateTokens(messagesToText(messages));

    res.write(sseEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant",
        model: reqModel, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }));

    const keepAlive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch (_) { clearInterval(keepAlive); }
    }, 8000);

    let fullContent = "";
    let textBlockOpen = false;
    const textBlockIndex = 0;

    try {
      for await (const chunk of sendToQwen(qwenMsgs, opts)) {
        fullContent += chunk;

        if (!textBlockOpen) {
          res.write(sseEvent("content_block_start", {
            type: "content_block_start", index: textBlockIndex,
            content_block: { type: "text", text: "" },
          }));
          textBlockOpen = true;
        }

        res.write(sseEvent("content_block_delta", {
          type: "content_block_delta", index: textBlockIndex,
          delta: { type: "text_delta", text: chunk },
        }));
      }

      if (textBlockOpen) {
        res.write(sseEvent("content_block_stop", {
          type: "content_block_stop", index: textBlockIndex,
        }));
      }

      const toolCalls = parseToolCalls(fullContent);
      let blockIdx = textBlockIndex + 1;
      for (const tc of toolCallsToAnthropicBlocks(toolCalls)) {
        const inputJson = JSON.stringify(tc.input);
        res.write(sseEvent("content_block_start", {
          type: "content_block_start", index: blockIdx,
          content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
        }));
        res.write(sseEvent("content_block_delta", {
          type: "content_block_delta", index: blockIdx,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }));
        res.write(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIdx }));
        blockIdx++;
      }

      const outputTokens = estimateTokens(fullContent);
      const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

      res.write(sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }));
      res.write(sseEvent("message_stop", { type: "message_stop" }));
      res.write(`data: [DONE]\n\n`);

      if (session.features.persistHistory) {
        reqSession.messages.push({ role: "user", content: messagesToText(messages) });
        if (fullContent) reqSession.messages.push({ role: "assistant", content: fullContent });
      }

    } catch (e) {
      console.error("[Anthropic Stream] Error:", e.message);
      res.write(sseEvent("error", { type: "error", error: { type: "api_error", message: e.message } }));
      res.write(`data: [DONE]\n\n`);
    } finally {
      clearInterval(keepAlive);
      res.end();
    }

  // ── NON-STREAMING ──
  } else {
    try {
      let fullContent = "";
      for await (const chunk of sendToQwen(qwenMsgs, opts)) {
        fullContent += chunk;
      }

      if (session.features.persistHistory) {
        reqSession.messages.push({ role: "user", content: messagesToText(messages) });
        if (fullContent) reqSession.messages.push({ role: "assistant", content: fullContent });
      }

      res.json(formatAnthropicResponse(fullContent, reqModel, requestId));
    } catch (e) {
      console.error("[Anthropic API] Error:", e.message);
      const status = e.message.includes("401") ? 401 : 500;
      res.status(status).json(formatAnthropicError(e.message));
    }
  }
});

// ============================================================
// ── OPENAI-COMPATIBLE /v1/chat/completions ──────────────────
// ============================================================

app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const {
    model: reqModel = config.qwen.defaultModel,
    messages,
    stream = false,
    thinking,
    search,
  } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json(formatOpenAIError("messages is required and must be an array", "invalid_request_error"));
  }

  const qwenModel = mapToQwenModel(reqModel);
  const reqSession = getOrCreateSession(req);
  const requestId = shortId();

  const systemMsg = messages.find(m => m.role === "system");
  const systemText = systemMsg?.content || null;
  const userMessages = messages.filter(m => m.role !== "system");

  const overrideOpts = {
    thinking: thinking !== undefined ? thinking : session.features.thinking,
    autoSearch: search !== undefined ? search : session.features.autoSearch,
    thinkingMode: session.features.thinkingMode,
    researchMode: session.features.researchMode,
  };

  const qwenMsgs = buildQwenMessages(userMessages, systemText, qwenModel, overrideOpts);

  const sendOpts = {
    model: qwenModel,
    reqSession,
    includeThinking: session.features.includeThinkingInOutput,
  };

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const keepAlive = setInterval(() => {
      try {
        res.write(`data: ${JSON.stringify(formatOpenAIResponse("", reqModel, requestId, true))}\n\n`);
      } catch (_) { clearInterval(keepAlive); }
    }, 8000);

    let fullContent = "";
    let sentContent = "";

    try {
      for await (const chunk of sendToQwen(qwenMsgs, sendOpts)) {
        fullContent += chunk;
        const delta = fullContent.substring(sentContent.length);
        if (delta) {
          sentContent = fullContent;
          res.write(`data: ${JSON.stringify(formatOpenAIResponse(delta, reqModel, requestId, true))}\n\n`);
        }
      }

      const remaining = fullContent.substring(sentContent.length);
      if (remaining) {
        res.write(`data: ${JSON.stringify(formatOpenAIResponse(remaining, reqModel, requestId, true))}\n\n`);
      }

      res.write(`data: ${JSON.stringify(formatOpenAIResponse("", reqModel, requestId, true, fullContent))}\n\n`);
      res.write("data: [DONE]\n\n");

      if (session.features.persistHistory) {
        reqSession.messages.push({ role: "user", content: messagesToText(userMessages) });
        if (fullContent) reqSession.messages.push({ role: "assistant", content: fullContent });
      }

    } catch (e) {
      console.error("[OAI Stream] Error:", e.message);
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
      res.write("data: [DONE]\n\n");
    } finally {
      clearInterval(keepAlive);
      res.end();
    }

  } else {
    try {
      let fullContent = "";
      for await (const chunk of sendToQwen(qwenMsgs, sendOpts)) {
        fullContent += chunk;
      }

      if (session.features.persistHistory) {
        reqSession.messages.push({ role: "user", content: messagesToText(userMessages) });
        if (fullContent) reqSession.messages.push({ role: "assistant", content: fullContent });
      }

      res.json(formatOpenAIResponse(fullContent, reqModel, requestId));
    } catch (e) {
      console.error("[OAI API] Error:", e.message);
      const status = e.message.includes("401") ? 401 : 500;
      res.status(status).json(formatOpenAIError(e.message));
    }
  }
});

// ============================================================
// ── /v1/models — fetch live from Qwen + Anthropic aliases ───
// ============================================================

app.get("/v1/models", authMiddleware, async (req, res) => {
  const anthropicAliases = [
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001",
  ];

  let qwenModels = [];
  try {
    const r = await fetch(`${BASE_URL}/api/v2/models/`, {
      headers: qwenHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.success && Array.isArray(data.data?.data)) {
        qwenModels = data.data.data.map(m => ({
          id: m.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "qwen",
          display_name: m.name || m.id,
        }));
      }
    }
  } catch (e) {
    console.warn("[Models] Fetch failed, using static list:", e.message);
    qwenModels = [
      "qwen3.6-plus", "qwen3.6-max-preview", "qwen3.5-plus", "qwen3.5-flash",
      "qwen3-max-2026-01-23", "qwen3-coder-plus", "qwen-plus-2025-07-28",
    ].map(id => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "qwen" }));
  }

  const aliasModels = anthropicAliases.map(id => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "anthropic",
    display_name: id,
  }));

  res.json({ object: "list", data: [...qwenModels, ...aliasModels] });
});

app.get("/models", authMiddleware, (req, res) => {
  res.redirect("/v1/models");
});

// ============================================================
// ── /features — toggle Qwen-specific settings ───────────────
// ============================================================

app.post("/features", authMiddleware, (req, res) => {
  const {
    thinking,
    threadingEnabled,
    autoSearch,
    thinkingMode,
    researchMode,
    persistHistory,
    includeThinkingInOutput,
  } = req.body;

  const validThinkingModes = ["Thinking", "Fast"];
  const validResearchModes = ["normal", "advance"];

  if (thinking !== undefined) session.features.thinking = !!thinking;
  if (autoSearch !== undefined) session.features.autoSearch = !!autoSearch;
  if (persistHistory !== undefined) session.features.persistHistory = !!persistHistory;
  if (includeThinkingInOutput !== undefined) session.features.includeThinkingInOutput = !!includeThinkingInOutput;
  if (threadingEnabled !== undefined) { session.features.threadingEnabled = !!threadingEnabled; if (!threadingEnabled) { for (const s of sessions.values()) s.parentId = null; } }

  if (thinkingMode !== undefined) {
    if (!validThinkingModes.includes(thinkingMode)) {
      return res.status(400).json({ error: `thinkingMode must be one of: ${validThinkingModes.join(", ")}` });
    }
    session.features.thinkingMode = thinkingMode;
  }

  if (researchMode !== undefined) {
    if (!validResearchModes.includes(researchMode)) {
      return res.status(400).json({ error: `researchMode must be one of: ${validResearchModes.join(", ")}` });
    }
    session.features.researchMode = researchMode;
  }

  console.log("[Features] Updated:", session.features);
  res.json({ success: true, features: session.features });
});

// ============================================================
// ── ADMIN / MISC ROUTES ──────────────────────────────────────
// ============================================================

app.post("/admin/session/clear", authMiddleware, (req, res) => {
  sessions.clear();
  console.log("[Admin] All sessions cleared.");
  res.json({ success: true, message: "All sessions cleared", activeSessions: 0 });
});

app.get("/admin/health", (req, res) => {
  const healthy = session.initialized;
  res.status(healthy ? 200 : 503).json({ healthy });
});

app.get("/admin/stats", (req, res) => {
  let totalMessages = 0;
  for (const s of sessions.values()) totalMessages += s.messages.length;
  res.json({
    activeSessions: sessions.size,
    totalMessages,
    features: session.features,
  });
});

// ============== START SERVER ==============

server.listen(config.server.port, config.server.host, async () => {
  const port = config.server.port;
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  Qwen Bridge Server Started                  ║
╠══════════════════════════════════════════════════════════════╣
║  Dashboard:       http://localhost:${String(port).padEnd(26)}║
║  Anthropic API:   http://localhost:${port}/v1/messages         ║
║  OpenAI API:      http://localhost:${port}/v1/chat/completions ║
╠══════════════════════════════════════════════════════════════╣
║  Auth Token:      ${config.auth.token.padEnd(43)}║
╠══════════════════════════════════════════════════════════════╣
║  Claude Code:                                                ║
║  set ANTHROPIC_BASE_URL=http://localhost:${String(port).padEnd(19)}║
║  set ANTHROPIC_AUTH_TOKEN=${config.auth.token.padEnd(35)}║
╚══════════════════════════════════════════════════════════════╝
`);

  try {
    await initializeSession();
  } catch (e) {
    console.warn("[Startup] Token validation deferred — will retry on first request.");
  }
});

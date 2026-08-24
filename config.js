"use strict";

module.exports = {
  parentIdControl: true,  // true=threading, false=always null
  
  server: {
    port: parseInt(process.env.PORT || "3456"),
    host: "0.0.0.0",
  },

  // Your Qwen token (from localStorage.getItem('token') or the cookie)
  qwen: {
    token: process.env.QWEN_TOKEN || "YOUR_QWEN_TOKEN_HERE",
    baseUrl: "https://chat.qwen.ai",
    defaultModel: "qwen3.6-plus",
    // Browser User-Agent — REQUIRED to pass the Aliyun WAF on /api/v2/chat/completions.
    // Non-browser UAs (node/undici) get a CAPTCHA punish page instead of JSON/SSE.
    userAgent:
      process.env.QWEN_USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    // Optional extra cookies appended after `token=<jwt>` (e.g. "atpsida=...; acw_tc=...").
    extraCookies: process.env.QWEN_COOKIES || "",
    // How many times to retry when the WAF serves its challenge page anyway.
    wafRetries: parseInt(process.env.QWEN_WAF_RETRIES || "2"),
  },

  // Auth for THIS proxy — clients must send this to talk to us
  auth: {
    enabled: process.env.AUTH_ENABLED !== "false",
    token: process.env.AUTH_TOKEN || "Waguri",
  },

  // Parse XML/JSON tool calls from model output and re-emit as proper tool_use blocks
  parseTool: process.env.PARSE_TOOL !== "false",

  logging: {
    level: process.env.LOG_LEVEL || "info", // "debug" | "info"
  },
};

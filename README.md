# Qwen Free API — chat.qwen.ai Proxy API

An **OpenAI-compatible** API proxy for [chat.qwen.ai](https://chat.qwen.ai). Drop it in front of any OpenAI-compatible tool and start using Qwen's models without browser automation or complex setup at runtime.

---

## Features

- **OpenAI-compatible** — `/v1/chat/completions` + `/v1/models`, drop-in for any OpenAI SDK client
- **Pure HTTP** — No Playwright, no Selenium, no browser overhead at runtime (single dependency: Express)
- **Aliyun WAF bypass** — Auth travels as the `token` cookie with a browser User-Agent; challenge pages are detected and retried automatically with backoff
- **Frontend version self-healing** — The `Version` header required by Qwen's completions API is scraped from the site bundle, cached 30 min, refreshed in the background, and retried once with a fresh value if Qwen bumps it mid-run
- **Streaming + non-streaming** — Full SSE support with keep-alive pings every 8 s
- **Per-session threading** — Optional `parent_id` chaining per `X-Session-Id`, with lazy Qwen chat creation and a 30-min TTL sweeper
- **Thinking summaries** — Qwen's `thinking_summary` phase can be streamed inline as `<thinking>` blocks
- **Live model list** — Models fetched from Qwen's `/api/v2/models` (falls back to a static list)
- **Runtime feature toggles** — Flip thinking, auto-search, threading, research mode, and more via `POST /features`
- **Built-in dashboard** — `GET /` serves a status page (token validity, sessions, feature flags)

---

## Supported Models

Models are fetched live from Qwen's `/api/v2/models`. If Qwen is unreachable, the fallback list is:

| Model ID | Notes |
|---|---|
| `qwen3.8-max` | Flagship model, excels at complex reasoning tasks |
| `qwen3.7-plus` | Newer high-performance model |
| `qwen3.7-max` | Max-tier variant |
| `qwen3.6-plus` | **Default model** — balanced performance |
| `qwen3.6-max-preview` | Preview max model |
| `qwen3.5-plus` | Previous-generation plus model |
| `qwen3.5-flash` | Fast, lightweight model |
| `qwen3-coder-plus` | Coding-specialised model |
| `qwen-plus-2025-07-28` | Dated snapshot |

### Model name mapping

Any requested `model` is resolved before hitting Qwen, so OpenAI-style names work too:

| Requested model contains | Mapped to |
|---|---|
| `max` | `qwen3.8-max` |
| `flash` | `qwen3.5-plus` |
| `coder` / `code` | `qwen3-coder-plus` |
| `qwen` | Passed through unchanged |
| *(anything else)* | `qwen3.6-plus` (default) |

> **Note:**
> - If you don't pass `model`, the server defaults to `qwen3.6-plus`.
> - `/models` (plural) redirects to `/v1/models`.

---

## Getting `QWEN_TOKEN`

`QWEN_TOKEN` is a Qwen JWT — **required**. Without a valid token every chat request fails.

1. Go to **https://chat.qwen.ai** and log in.
2. Open browser **DevTools** (`F12` or `Ctrl+Shift+I`).
3. Navigate to **Application → Local Storage → https://chat.qwen.ai**.
4. Find the key named **`token`** and copy its value.
5. Export it before starting the server:

   ```bash
   # Linux / macOS
   export QWEN_TOKEN="paste-the-copied-jwt-here"

   # Windows PowerShell
   $env:QWEN_TOKEN="paste-the-copied-jwt-here"
   ```

   Or, in the DevTools **Console** tab, run:

   ```js
   localStorage.getItem('token')
   ```

   and copy the printed string.

---

## Getting Started

```bash
# 1. Clone the repo
git clone https://github.com/izaart95-jpg/Qwen-Free-Api/ qwen-api
cd qwen-api

# 2. Install dependencies
npm install
# or: pnpm install

# 3. Export your Qwen token
export QWEN_TOKEN="paste-the-copied-jwt-here"

# 4. Start the server (Node >= 18)
node main.js
# or: npm start
# auto-reload during development:
#   npm run dev
```

On startup, you'll see a banner with your dashboard URL, the OpenAI endpoint, and the auth token. The Qwen token is validated asynchronously — if startup validation fails, the first chat request will retry it.

---

## Configuration

All configuration is environment-driven (see `config.js`). No CLI flags.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3456` | HTTP server port |
| `AUTH_ENABLED` | `true` | Require client authentication (`false` disables auth entirely) |
| `AUTH_TOKEN` | `Waguri` | Bearer / `x-api-key` token clients must send |
| `QWEN_TOKEN` | *(placeholder)* | Qwen JWT — sent as the `token` cookie to chat.qwen.ai |
| `QWEN_COOKIES` | *(empty)* | Extra cookies appended after `token=<jwt>` (e.g. `"atpsida=...; acw_tc=..."`) |
| `QWEN_USER_AGENT` | *(Chrome UA)* | Browser User-Agent — **required** to pass the Aliyun WAF; non-browser UAs get a CAPTCHA punish page |
| `QWEN_WAF_RETRIES` | `2` | How many times to retry when the WAF serves its challenge page anyway |
| `QWEN_FE_VERSION` | `auto` | Pin the frontend `Version` header (e.g. `0.2.87`) to skip scraping; `auto` scrapes + self-heals |
| `LOG_LEVEL` | `info` | Log level — `debug` dumps every Qwen request body and raw SSE line |

### `config.js` options (file-level)

| Option | Default | Description |
|---|---|---|
| `parentIdControl` | `true` | `true` = thread replies via `parent_id`; `false` = always send `null` |
| `qwen.baseUrl` | `https://chat.qwen.ai` | Upstream base URL |
| `qwen.defaultModel` | `qwen3.6-plus` | Model used when none is requested |

---

## API Reference

### OpenAI-Compatible

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | ✅ | Chat completions (streaming + non-streaming) |
| `GET`  | `/v1/models` | ✅ | Live model list from Qwen |
| `GET`  | `/models` | ✅ | Redirects to `/v1/models` |

#### `/v1/chat/completions` body

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | string | *(mapped)* | Any model ID from `/v1/models`, or an alias (see [mapping](#model-name-mapping)) |
| `messages` | array | *(required)* | OpenAI-style message array |
| `stream` | bool | `false` | SSE stream when `true` |
| `thinking` | bool | *(server setting)* | Override `thinking_enabled` for this request |
| `search` | bool | *(server setting)* | Override `auto_search` for this request |

System messages are folded into the first user message before being sent upstream.

#### Request headers

| Header | Purpose |
|---|---|
| `Authorization: Bearer <AUTH_TOKEN>` | OpenAI-style auth |
| `x-api-key: <AUTH_TOKEN>` | Alternative auth style |
| `X-Session-Id: <id>` | Groups requests into one proxied conversation (default: `"default"`) |
| `X-Fresh-Session: true` | Discard the stored session and start a brand-new Qwen chat |

### Management

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET`  | `/` | ❌ | HTML dashboard — token status, sessions, feature flags |
| `GET`  | `/status` | ❌ | JSON status (`tokenValid`, `userId`, `activeSessions`, `features`) |
| `POST` | `/features` | ✅ | Runtime feature toggles (see below) |
| `POST` | `/admin/session/clear` | ✅ | Clear all session histories and chat IDs |
| `GET`  | `/admin/health` | ❌ | Health check (`200` if the token is initialised, else `503`) |
| `GET`  | `/admin/stats` | ❌ | `activeSessions`, `totalMessages`, current `features` |

---

## `/features` — Server-Wide Feature Configuration

Features apply to **all subsequent requests** until changed again.

```bash
curl -X POST http://localhost:3456/features \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -d '{"thinking": false}'
```

Response:

```json
{
  "success": true,
  "features": {
    "thinking": false,
    "autoSearch": true,
    "thinkingMode": "Thinking",
    "researchMode": "advance",
    "persistHistory": false,
    "threadingEnabled": false,
    "includeThinkingInOutput": false
  }
}
```

### Toggleable keys

| Key | Values | Behaviour |
|---|---|---|
| `thinking` | bool | Enables/disables `thinking_enabled` upstream |
| `autoSearch` | bool | Toggles Qwen's automatic web search |
| `thinkingMode` | `"Thinking"` \| `"Fast"` | Deep-thinking vs fast mode (invalid values → `400`) |
| `researchMode` | `"normal"` \| `"advance"` | Research depth (invalid values → `400`) |
| `threadingEnabled` | bool | Chain requests via `parent_id`; disabling resets all stored parents |
| `persistHistory` | bool | Keep request/response pairs for `/admin/stats` (not replayed to Qwen) |
| `includeThinkingInOutput` | bool | Stream the `thinking_summary` phase as `<thinking>...</thinking>` blocks |

---

## Examples

All examples use the defaults: `localhost:3456`, auth `Waguri`, default model `qwen3.6-plus`.

**Basic non-streaming request**

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -d '{
    "stream": false,
    "messages": [{"role": "user", "content": "Hello, who are you?"}]
  }'
```

**Streaming (SSE)**

```bash
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -d '{
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku about JavaScript."}]
  }'
```

**Deep thinking with visible reasoning**

```bash
# 1. Let thinking summaries through to the client
curl -X POST http://localhost:3456/features \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -d '{"includeThinkingInOutput": true}'

# 2. Request with thinking enabled
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -d '{
    "stream": true,
    "thinking": true,
    "messages": [{"role": "user", "content": "Summarize today'\''s top AI news."}]
  }'
```

**Multi-turn conversation (session threading)**

```bash
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -H "X-Session-Id: my-chat" \
  -d '{"stream": true, "messages": [{"role": "user", "content": "My name is Ada."}]}'

curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer Waguri" \
  -H "X-Session-Id: my-chat" \
  -d '{"stream": true, "messages": [{"role": "user", "content": "What is my name?"}]}'
```

Both requests share one Qwen chat; the second reply chains onto the first via `parent_id`.

**Python (OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="Waguri",
)

resp = client.chat.completions.create(
    model="qwen3.6-plus",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

---

## How It Works

1. **Token validation** — On startup the server decodes the user ID from the JWT payload and pings Qwen's `/api/v2/configs/` to confirm the token is alive. A `401` here means `QWEN_TOKEN` is invalid or expired. If validation fails at boot, it is retried on the first chat request.

2. **WAF bypass** — Qwen sits behind an Aliyun WAF. Empirically, only a browser-shaped request passes: the JWT must travel as the **`token` cookie** (a `Bearer` header gets a CAPTCHA punish page), and a real browser `User-Agent` is mandatory. Responses whose content type is `text/html` are treated as WAF challenges and retried up to `QWEN_WAF_RETRIES` times with linear backoff and a fresh `X-Request-Id` per attempt.

3. **Frontend `Version` header** — `/api/v2/chat/completions` rejects requests without the web app's frontend version (`200` JSON `Bad_Request "Internal error..."`). The version is scraped from the homepage's bundle path (`.../qwen-chat-fe/<VERSION>/js/main.js`), cached for 30 minutes, refreshed in the background, and — if completions reject a stale value — force-refreshed once and the request retried with the new header. Set `QWEN_FE_VERSION` to pin it.

4. **Chat lifecycle** — Each `X-Session-Id` maps to an in-memory session holding a lazily created Qwen chat (`POST /api/v2/chats/new`). Messages are converted to Qwen's shape: roles flattened to `user`/`assistant`, system text injected into the first user message, and a `feature_config` attached (`thinking_enabled`, `output_schema: "phase"`, `research_mode`, `thinking_mode`, `thinking_format: "summary"`, `auto_search`). When threading is on, the last response's ID becomes the next request's `parent_id`.

5. **Streaming** — Qwen's SSE is parsed (`response.created`, `phase: "thinking_summary"`, `delta.content`) and re-emitted as standard OpenAI chunks, terminated with `data: [DONE]`. Keep-alive pings are written every 8 s so idle proxies don't drop the connection.


---

## Project Structure

```
qwen-api/
├── main.js          # Express server: endpoints, WAF handling, SSE bridge, dashboard
├── config.js        # Env-driven configuration (token, auth, WAF, logging)
├── package.json
└── README.md
```

---

## Notes

- **OpenAI-compatible only** — there is no Anthropic `/v1/messages` endpoint; point OpenAI-style clients at `http://localhost:<port>/v1`.
- `usage` token counts are estimates (`characters / 4`) — treat them as approximations.
- Sessions live **in memory only**: they survive until restart or a 30-minute idle TTL (swept every 5 minutes), and `POST /admin/session/clear` wipes them immediately.
- Text-to-text only (`chat_type: "t2t"`) — image and file uploads are not supported.
- `persistHistory` stores exchanges for `/admin/stats`; stored messages are never replayed to Qwen — multi-turn context comes from threading (`parent_id`), not history replay.
- The default auth token (`Waguri`) is a placeholder — set `AUTH_TOKEN` in production.
- `LOG_LEVEL=debug` dumps every Qwen request body, raw SSE line, and response metadata — useful for troubleshooting WAF/version issues.
- If Qwen answers `401`, your `QWEN_TOKEN` expired — grab a fresh one from `localStorage.getItem('token')`.

---

## License

Provided under MIT License. Use responsibly and in accordance with Qwen's terms of service.

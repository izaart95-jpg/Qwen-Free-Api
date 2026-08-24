# Qwen Bridge

A proxy server for `chat.qwen.ai` exposing **OpenAI-compatible** and **Anthropic-compatible** endpoints.

## Setup

```bash
npm install
```

Edit `config.js` and set your `QWEN_TOKEN`, or use env vars:

```bash
QWEN_TOKEN=eyJhbGci...  AUTH_TOKEN=Waguri  node main.js
```

Get your token from the browser console on chat.qwen.ai:
```js
localStorage.getItem('token')
```

## Claude Code

```bash
set ANTHROPIC_BASE_URL=http://localhost:3456
set ANTHROPIC_AUTH_TOKEN=Waguri
set ANTHROPIC_API_KEY=
claude
```

Or in `~/.claude/settings.json`:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3456",
    "ANTHROPIC_AUTH_TOKEN": "Waguri",
    "ANTHROPIC_API_KEY": ""
  }
}
```

## Model Mapping

| Requested model | Qwen model used |
|---|---|
| claude-opus / max | qwen3.6-max-preview |
| claude-haiku / flash | qwen3.5-flash |
| *-coder / *-code | qwen3-coder-plus |
| qwen3.6-plus (etc.) | passed through directly |
| anything else | qwen3.6-plus (default) |

## Chat Modes (via /features)

```bash
# Normal chat (default)
curl -X POST http://localhost:3456/features -H "Authorization: Bearer Waguri" \
  -H "Content-Type: application/json" -d '{"chatType":"t2t"}'

# Artifacts / code playground
curl ... -d '{"chatType":"artifacts"}'

# Web Dev
curl ... -d '{"chatType":"web_dev"}'

# Slides
curl ... -d '{"chatType":"slides"}'

# Deep Research (normal)
curl ... -d '{"chatType":"deep_research","researchMode":"normal"}'

# Deep Research (advance)
curl ... -d '{"chatType":"deep_research","researchMode":"advance"}'

# Toggle thinking
curl ... -d '{"thinking":false}'
curl ... -d '{"thinkingMode":"Fast"}'

# Include <thinking> blocks in output
curl ... -d '{"includeThinkingInOutput":true}'

# Toggle auto search
curl ... -d '{"autoSearch":false}'
```
---

## Threading Mode

Threading controls whether the proxy maintains conversation history via Qwen's `parent_id` mechanism.

### Enable/Disable Threading

```bash
# Enable threading (maintains conversation context across messages)
curl -X POST http://localhost:3456/features \
  -H "Authorization: Bearer Waguri" \
  -H "Content-Type: application/json" \
  -d '{"threadingEnabled": true}'
  ```
```bash
# Disable threading (each message starts fresh conversation)
curl -X POST http://localhost:3456/features \
  -H "Authorization: Bearer Waguri" \
  -H "Content-Type: application/json" \
  -d '{"threadingEnabled": false}'
  ```

## Available chatType values

`t2t` | `artifacts` | `web_dev` | `slides` | `deep_research` | `search` | `learn` | `travel`

## Notes

- **WAF**: chat.qwen.ai's Aliyun WAF requires the JWT to be sent as the `token` **cookie** plus a browser `User-Agent` on `/api/v2/chat/completions`. A `Authorization: Bearer` header or non-browser UA gets an HTTP 200 HTML CAPTCHA (`_____tmd_____/punish?x5secdata=...`) instead of JSON/SSE. This proxy sends cookie auth + Chrome UA by default; override via `QWEN_USER_AGENT` / `QWEN_COOKIES`, tune retries with `QWEN_WAF_RETRIES`.
- **`Version` header (REQUIRED)**: `/api/v2/chat/completions` rejects requests that lack the frontend version header (`Version: 0.2.87`) with HTTP 200 JSON `{"code":"Bad_Request","details":"Internal error..."}` — chat creation and token validation do NOT need it, which makes this failure easy to misdiagnose. Verified against the site's own JS bundle (qwen-chat-fe 0.2.87) on 2026-08-24. Override via `QWEN_FE_VERSION` if Qwen ships a new frontend version and completions start failing again.
- Each proxy session gets its own Qwen `chat_id` (created lazily on first request)
- Switching `chatType` via `/features` clears all sessions so new chats use the new type
- `x-session-id` header lets clients maintain separate conversation threads
- `x-fresh-session: true` header forces a new chat session

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

- Each proxy session gets its own Qwen `chat_id` (created lazily on first request)
- Switching `chatType` via `/features` clears all sessions so new chats use the new type
- `x-session-id` header lets clients maintain separate conversation threads
- `x-fresh-session: true` header forces a new chat session

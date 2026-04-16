# Kunilingus Bridge

> **Vibe code from your phone.** Bridge your Telegram/WhatsApp bot to GitHub Copilot inside VS Code.

[![Version](https://img.shields.io/visual-studio-marketplace/v/fonnzer.kunilingus-bridge)](https://marketplace.visualstudio.com/items?itemName=fonnzer.kunilingus-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is this?

Kunilingus Bridge exposes a local HTTP server that lets external programs — like a Telegram or WhatsApp bot — talk to **GitHub Copilot** and control **VS Code** remotely. Think of it as an API gateway to your entire editor.

Send a message from your phone → your bot forwards it to the bridge → Copilot answers → the bridge webhooks the response back to your bot → you read it on Telegram. All while your laptop sits at home.

### Key Features

- **Chat with Copilot** — `/chat` and OpenAI-compatible `/v1/chat/completions`
- **Model switching** — pick GPT-4o, Claude Sonnet, or whatever Copilot offers
- **Webhook delivery** — auto-POST responses to your bot with HMAC-SHA256 signatures
- **Smart summarization** — long answers get summarized before hitting Telegram/WhatsApp
- **Full VS Code control** — files, editor, terminal, git, diagnostics, workspace
- **Settings panel** — friendly webview UI, no JSON editing required
- **Security** — optional Bearer token + rate limiting
- **Zero dependencies** — pure Node.js built-in modules only

---

## Quick Start

1. **Install** the extension from the VS Code marketplace (or `code --install-extension fonnzer.kunilingus-bridge`)
2. The server **starts automatically** on port `3789`
3. Test it:
   ```bash
   curl http://localhost:3789/status
   ```
4. Chat with Copilot:
   ```bash
   curl -X POST http://localhost:3789/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "Explain async/await in JavaScript"}'
   ```

### Connect your Bot

Set the webhook URL so responses flow back to your Telegram/WhatsApp bot:

1. Open Command Palette → **Kunilingus Bridge: Open Settings Panel**
2. Fill in your bot's webhook URL
3. Optionally set a signing secret for HMAC verification
4. Send a test: `curl -X POST http://localhost:3789/webhook/test`

---

## Configuration

Open the settings panel via Command Palette → **Kunilingus Bridge: Open Settings Panel**, or edit `settings.json` directly:

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `3789` | Server port |
| `bindAddress` | `127.0.0.1` | Bind address (`0.0.0.0` for remote) |
| `autoStart` | `true` | Start on VS Code launch |
| `apiKey` | `""` | Bearer token for auth |
| `defaultModel` | `""` | Model family (e.g. `gpt-4o`) |
| `maxResponseTokens` | `4096` | Max tokens per response |
| `webhookUrl` | `""` | Bot webhook URL |
| `webhookSecret` | `""` | HMAC-SHA256 signing secret |
| `messagingPlatform` | `auto` | `auto` / `telegram` / `whatsapp` |
| `summarizeForMessaging` | `true` | Auto-summarize long answers |
| `summaryMaxChars` | `500` | Max chars for summaries |
| `rateLimitPerMinute` | `60` | Request rate limit (0=off) |

---

## Commands

| Command | Description |
|---------|-------------|
| **Start Server** | Launch the HTTP bridge |
| **Stop Server** | Shut down the bridge |
| **Show Status** | Display connection info |
| **Select AI Model** | Pick a Copilot model |
| **Configure Webhook URL** | Set your bot's callback URL |
| **Open Settings Panel** | Visual configuration UI |
| **Show Logs** | Open the output channel |

---

## API Endpoints

All endpoints return JSON. Set `Authorization: Bearer <key>` if you configured an API key.

### Core

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Server status, uptime, config |
| `GET` | `/models` | Available Copilot models |
| `GET` | `/config` | Current configuration |
| `GET` | `/endpoints` | List all endpoints |
| `POST` | `/chat` | Send message to Copilot |
| `POST` | `/v1/chat/completions` | OpenAI-compatible endpoint |
| `POST` | `/select-model` | Switch AI model |
| `POST` | `/webhook/test` | Test webhook delivery |

### Workspace

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspace/folders` | List workspace folders |
| `POST` | `/workspace/open` | Open a folder |
| `POST` | `/workspace/add` | Add folder to workspace |
| `POST` | `/workspace/remove` | Remove folder |

### Files

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/files/list` | List files (with glob) |
| `POST` | `/files/read` | Read file contents |
| `POST` | `/files/write` | Write/append to file |
| `POST` | `/files/delete` | Delete file or directory |
| `POST` | `/files/mkdir` | Create directory |
| `POST` | `/files/rename` | Rename/move file |
| `POST` | `/files/search` | Search in files (grep) |

### Editor

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/editor/open` | Open file in editor |
| `GET` | `/editor/active` | Active editor info |
| `POST` | `/editor/edit` | Apply edits |
| `POST` | `/editor/replace` | Search & replace in file |
| `POST` | `/editor/diff` | Open diff view |
| `POST` | `/editor/save-all` | Save all open files |
| `POST` | `/editor/close` | Close editor tabs |

### Terminal & Git

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/terminal/exec` | Execute command (returns output) |
| `POST` | `/terminal/create` | Create named terminal |
| `POST` | `/terminal/send` | Send text to terminal |
| `GET` | `/terminal/list` | List terminals |
| `POST` | `/git` | Run any git command |

### Bot / Messaging

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/say` | Send message (chat/notify/log) |
| `GET` | `/messages` | Poll message queue |
| `POST` | `/copilot` | Interact with Copilot Chat panel |

### System

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/command` | Run any VS Code command |
| `GET` | `/diagnostics` | Get compile errors/warnings |
| `POST` | `/auto-accept` | Toggle auto-accept mode |
| `POST` | `/trust` | Trust current workspace |
| `POST` | `/setup-vibe-coding` | Auto-configure VS Code for vibe coding |

---

## Webhook Format

When a webhook URL is configured, every Copilot response is POSTed as:

```json
{
  "type": "response",
  "platform": "telegram",
  "model": "gpt-4o",
  "request": "explain async/await",
  "response": "Summarized answer...",
  "fullLength": 2048,
  "summarized": true,
  "timestamp": "2025-01-15T12:00:00.000Z"
}
```

If `webhookSecret` is set, a `X-Bridge-Signature: sha256=<hmac>` header is included.

---

## Security Notes

- By default the server binds to `127.0.0.1` (localhost only)
- **Always set an API key** when binding to `0.0.0.0`
- Rate limiting is enabled by default (60 req/min)
- Webhook payloads can be HMAC-signed for verification
- The extension requires **GitHub Copilot** to be active for AI features

---

## Requirements

- VS Code 1.109.0+
- GitHub Copilot extension (for AI/chat features)

---

## License

[MIT](LICENSE)

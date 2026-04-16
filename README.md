# Kunilingus Bridge

VS Code extension that bridges **OpenClaw bots** (Telegram / WhatsApp) to **GitHub Copilot** — enabling remote vibe coding from your phone.

## How It Works

```
You (phone)
  │  Telegram / WhatsApp
  ▼
OpenClaw Bot ("Kunilingus")
  │  HTTP POST
  ▼
Kunilingus Bridge (VS Code extension)
  │  VS Code Language Model API
  ▼
GitHub Copilot ──▶ response ──▶ webhook ──▶ bot ──▶ you
```

The extension starts an HTTP server inside VS Code. Your OpenClaw bot sends instructions via HTTP, the bridge executes them through Copilot's LLM, and POSTs a summary back to your bot via webhook — which delivers it to Telegram or WhatsApp.

## Quick Start

1. Install the extension in VS Code
2. Open Command Palette → **Kunilingus Bridge: Configure Webhook URL** → enter your bot's webhook URL
3. Open Command Palette → **Kunilingus Bridge: Select AI Model** → pick your preferred model
4. The bridge auto-starts on VS Code launch (configurable)

## Configuration

All settings are in **VS Code Settings** (`Ctrl+,` → search "kunilingus"):

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `3789` | HTTP server port |
| `bindAddress` | `127.0.0.1` | Network interface. `0.0.0.0` for remote access |
| `autoStart` | `true` | Start server on VS Code launch |
| `apiKey` | `""` | Bearer token for auth (required if exposing remotely!) |
| `defaultModel` | `""` | Model family override (empty = auto-select) |
| `webhookUrl` | `""` | URL to POST results back to your bot |
| `webhookSecret` | `""` | HMAC-SHA256 secret for signing webhook payloads |
| `messagingPlatform` | `auto` | `telegram`, `whatsapp`, or `auto` — affects formatting |
| `maxResponseTokens` | `4096` | Max tokens per response (lower = cheaper) |
| `summarizeForMessaging` | `true` | Auto-summarize long responses for messaging |
| `summaryMaxChars` | `500` | Max chars for summaries sent to Telegram/WhatsApp |
| `rateLimitPerMinute` | `60` | Request throttling (0 = unlimited) |

## Commands

| Command | Description |
|---------|-------------|
| **Start Server** | Start the bridge |
| **Stop Server** | Stop the bridge |
| **Show Status** | Show current status |
| **Select AI Model** | Pick from available Copilot models |
| **Configure Webhook URL** | Set/change the webhook endpoint |

## API Endpoints

### Discovery

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Bridge status, uptime, webhook/model info |
| `GET` | `/models` | List available AI models |
| `GET` | `/config` | Current configuration |
| `GET` | `/endpoints` | Full endpoint list |

### Chat / LLM

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat` | Simple chat (single or multi-turn) |
| `POST` | `/v1/chat/completions` | OpenAI-compatible endpoint |
| `POST` | `/select-model` | Switch AI model at runtime |

### Workspace & Files

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workspace/folders` | List workspace folders |
| `POST` | `/workspace/open` | Open a folder |
| `POST` | `/workspace/add` | Add folder to workspace |
| `POST` | `/workspace/remove` | Remove folder |
| `GET` | `/files/list` | List files (glob pattern) |
| `POST` | `/files/read` | Read file content |
| `POST` | `/files/write` | Write/append to file |
| `POST` | `/files/delete` | Delete file or directory |
| `POST` | `/files/mkdir` | Create directory |
| `POST` | `/files/rename` | Rename/move file |
| `POST` | `/files/search` | Search in files (grep) |

### Editor & Terminal

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/editor/open` | Open file in editor |
| `GET` | `/editor/active` | Active editor info |
| `POST` | `/editor/edit` | Edit file by line range |
| `POST` | `/editor/replace` | Search & replace |
| `POST` | `/editor/diff` | Diff two files |
| `POST` | `/editor/save-all` | Save all files |
| `POST` | `/editor/close` | Close editor |
| `POST` | `/terminal/exec` | Execute shell command |
| `POST` | `/terminal/create` | Create terminal |
| `POST` | `/terminal/send` | Send text to terminal |
| `GET` | `/terminal/list` | List terminals |

### Git, Copilot & System

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/git` | Run git command |
| `POST` | `/copilot` | Interact with Copilot Chat |
| `GET` | `/diagnostics` | Get lint/compile errors |
| `POST` | `/auto-accept` | Toggle auto-accept mode |
| `POST` | `/trust` | Trust workspace |
| `POST` | `/setup-vibe-coding` | Configure VS Code for vibe coding |
| `POST` | `/command` | Run any VS Code command |
| `POST` | `/say` | Send message to chat/notification |
| `GET` | `/messages` | Poll message queue |
| `POST` | `/webhook/test` | Test webhook delivery |

## Usage Examples

### From OpenClaw bot (Python)
```python
import requests

BRIDGE = "http://127.0.0.1:3789"
HEADERS = {"Authorization": "Bearer YOUR_API_KEY"}  # if apiKey is set

# Send instruction to Copilot
r = requests.post(f"{BRIDGE}/chat", json={
    "message": "Add input validation to the signup form",
    "maxTokens": 2048
}, headers=HEADERS)
print(r.json()["response"])

# Switch model
requests.post(f"{BRIDGE}/select-model", json={"family": "claude-sonnet"}, headers=HEADERS)

# Run terminal command
requests.post(f"{BRIDGE}/terminal/exec", json={"command": "npm test"}, headers=HEADERS)
```

### OpenAI SDK compatible
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3789/v1", api_key="YOUR_API_KEY")
response = client.chat.completions.create(
    model="any",
    messages=[{"role": "user", "content": "Refactor the auth module"}],
    max_tokens=4096
)
print(response.choices[0].message.content)
```

## Webhook Format

When `webhookUrl` is configured, the bridge POSTs responses back:

```json
{
  "type": "response",
  "platform": "telegram",
  "model": "gpt-4o",
  "request": "Add input validation...",
  "response": "Done! Added validation for email, password length...",
  "fullLength": 2847,
  "summarized": true,
  "timestamp": "2026-04-16T12:00:00.000Z"
}
```

If `webhookSecret` is set, requests include `X-Bridge-Signature: sha256=<hmac>` for verification.

## Security

- **Always set `apiKey`** when exposing the bridge beyond localhost
- **Use `webhookSecret`** to verify webhook payloads
- Default `bindAddress` is `127.0.0.1` (localhost only)
- Rate limiting protects against abuse

## Portability

No hardcoded paths — works on any machine. All configuration is via VS Code settings, which sync across devices with Settings Sync.

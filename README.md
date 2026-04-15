# Kunilingus Bridge

HTTP bridge that lets **Clawbot** (or any external agent) access **GitHub Copilot's language models** through VS Code's Language Model API.

## How It Works

The extension starts a local HTTP server on `127.0.0.1:3789` (configurable). Clawbot sends HTTP requests to this server, the extension forwards them to Copilot's LLM via the VS Code API, and returns the responses.

```
Clawbot ──HTTP──▶ Kunilingus Bridge (VS Code) ──LM API──▶ GitHub Copilot
                         ◀── response ──                    ◀── response ──
```

## Endpoints

### `GET /status`

Returns bridge status.

```json
{ "active": true, "port": 3789, "version": "1.0.0", "uptime": 120 }
```

### `GET /models`

Lists available language models.

```json
[
  { "id": "<auto-detected>", "family": "...", "vendor": "copilot", "version": "...", "maxInputTokens": 128000 }
]
```

### `POST /chat`

Simple chat endpoint. Supports single-turn and multi-turn conversations.

**Single message:**
```json
{
  "message": "Explain what a monad is",
  "systemPrompt": "You are a helpful assistant",
  "stream": false
}
```

**Multi-turn conversation:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello" },
    { "role": "assistant", "content": "Hi! How can I help?" },
    { "role": "user", "content": "Explain closures in JavaScript" }
  ],
  "stream": true
}
```

**Response (non-streaming):**
```json
{
  "response": "A monad is...",
  "model": "<el modelo que estés usando>"
}
```

**Response (streaming):** SSE stream with `data: {"content": "chunk"}` events, ending with `data: [DONE]`.

### `POST /v1/chat/completions`

**OpenAI-compatible** endpoint. Use this with any OpenAI SDK by pointing it to `http://127.0.0.1:3789/v1`.

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant" },
    { "role": "user", "content": "Hello" }
  ],
  "stream": false
}
```

Returns a standard OpenAI-format response.

## Clawbot Quick Start

### Python (requests)
```python
import requests

r = requests.post("http://127.0.0.1:3789/chat", json={
    "message": "Write a hello world in Rust",
    "stream": False
})
print(r.json()["response"])
```

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3789/v1", api_key="unused")
response = client.chat.completions.create(
    model="any",  # el bridge usa automáticamente tu modelo activo
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### curl
```bash
curl http://127.0.0.1:3789/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hi!", "stream": false}'
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `kunilingus-bridge.port` | `3789` | Server port |
| `kunilingus-bridge.autoStart` | `true` | Start on VS Code launch |
| `kunilingus-bridge.apiKey` | `""` | Optional Bearer token auth |
| `kunilingus-bridge.defaultModel` | `""` | Preferred model family |

## Authentication

If `apiKey` is set, all requests must include:
```
Authorization: Bearer YOUR_API_KEY
```

## Commands

- **Kunilingus Bridge: Start Server** — Start the bridge
- **Kunilingus Bridge: Stop Server** — Stop the bridge
- **Kunilingus Bridge: Show Status** — Show current status

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**

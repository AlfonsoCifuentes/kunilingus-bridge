# Changelog

All notable changes to **Kunilingus Bridge** are documented here.

## [2.2.0] — 2025-04-16

### Added
- **Settings Panel** — webview-based configuration UI (`Open Settings Panel` command)
- **Show Logs** command — quick access to the output channel
- Extension icon for the marketplace
- `LICENSE` (MIT), marketplace metadata, keywords, categories, gallery banner
- Command palette conditions (start/stop visibility based on server state)
- Request counter visible in status command
- Proper `min`/`max` validation and `order` for all settings

### Changed
- Version constant extracted — no more hardcoded version strings
- Status bar tooltip and messages use the version constant
- Output channel uses structured log mode

## [2.1.0] — 2025-04-15

### Added
- **Webhook delivery** — auto-POST Copilot responses to your bot (Telegram/WhatsApp)
- **HMAC-SHA256 webhook signing** — `X-Bridge-Signature` header with shared secret
- **Model switching** — `/select-model` endpoint and `Select AI Model` command
- **Rate limiting** — configurable requests-per-minute cap
- **Response summarization** — auto-summarize long responses for messaging platforms
- **Platform formatting** — Telegram Markdown and WhatsApp formatting modes
- **Bind address** — `bindAddress` setting for remote access (`0.0.0.0`)
- **Max response tokens** — `maxResponseTokens` setting to control cost
- `/config` endpoint to inspect current settings
- `/webhook/test` endpoint
- `/endpoints` endpoint listing all routes

### Changed
- OpenAI-compatible `/v1/chat/completions` now supports streaming

## [2.0.0] — 2025-04-14

### Added
- Full HTTP REST API with 30+ endpoints
- Workspace management (open/add/remove folders)
- File operations (read/write/delete/mkdir/rename/search)
- Editor control (open/edit/replace/diff/save/close)
- Terminal execution and management
- Git command proxy
- Copilot Chat panel interaction
- VS Code command proxy (`/command`)
- Message queue with polling (`/say` + `/messages`)
- Diagnostics endpoint
- Auto-accept and vibe-coding setup
- Status bar indicator
- CORS headers for browser clients

## [1.0.0] — 2025-04-13

### Added
- Initial release
- Basic HTTP bridge server
- `/chat` endpoint for Copilot conversations
- Auto-start on VS Code launch
- API key authentication
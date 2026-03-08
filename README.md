# Cobrain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3.5+-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)

A Telegram-first personal AI assistant with local memory, autonomous workflows, and a minimal HTTP API for external agents and automations.

## Features

- **Telegram-First Interface** - Chat directly with the bot and manage it through Telegram commands
- **Intelligent Memory** - FTS5 + Haiku powered memory with semantic search
- **Living Assistant** - Proactive awareness with context-aware notifications
- **Evolving Persona** - Adapts communication style based on your preferences
- **Goals & Reminders** - Track objectives and get timely notifications
- **MCP Tools** - Extensible tool system for memory, files, and more
- **Minimal HTTP API** - Expose `/api/chat`, `/api/report`, and memory endpoints for integrations
- **Single-User Design** - Self-hosted, your data stays local

## Quick Start

```bash
# Clone and install
git clone https://github.com/yourusername/cobrain.git
cd cobrain
bun install

# Configure (edit with your credentials)
cp .env.example .env

# Run
bun run dev
```

## Requirements

- [Bun](https://bun.sh) v1.3.5+
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- Anthropic API Key

## Configuration

Create a `.env` file with:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
MY_TELEGRAM_ID=your_telegram_id
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

See [Configuration Guide](docs/configuration.md) for all options.

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Installation and first run |
| [Architecture](docs/architecture.md) | System design and data flow |
| [Configuration](docs/configuration.md) | Environment variables and options |
| **Channels** | |
| [Telegram](docs/channels/telegram.md) | Bot commands and usage |
| **Features** | |
| [Persona](docs/features/persona.md) | AI personality system |
| [Memory](docs/features/memory.md) | Memory layers and search |
| [Goals](docs/features/goals.md) | Goals and reminders |
| [Tools](docs/features/tools.md) | MCP tools reference |
| **API** | |
| [HTTP API](docs/api/http.md) | HTTP endpoints |
| **Operations** | |
| [Deployment](docs/deployment.md) | Production deployment |
| [Contributing](docs/contributing.md) | Development guide |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Language | TypeScript |
| AI | Claude + Gemini (optional transcription) |
| Database | SQLite + FileMemory |
| Telegram | grammy |
| HTTP API | Bun.serve |

## Project Structure

```
src/
├── agent/          # Agent orchestration and tool wiring
├── agents/         # Seed agents and registry
├── api-server.ts   # Minimal HTTP API
├── brain/          # AI orchestration
├── channels/       # Telegram handlers and routing
├── i18n/           # Localized strings
├── memory/         # Memory subsystem
├── services/       # Business logic
├── types/          # TypeScript interfaces
└── utils/          # Helpers
```

## Scripts

```bash
bun run dev         # Development with hot reload
bun run start       # Production
bun test            # Run tests
bun run typecheck   # Type check
```

## License

MIT

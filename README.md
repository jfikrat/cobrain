# Cobrain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)

Self-hosted Telegram AI assistant with local memory, autonomous workflows, and multi-agent support. Powered by Claude.

**You bring your own Anthropic API key. Your data stays on your machine.**

## Features

- **Telegram-native** — chat, voice messages, images, inline suggestions
- **Persistent memory** — facts + events stored as Markdown files, fully inspectable
- **Autonomous behaviors** — reminders, proactive checks, scheduled tasks via BrainLoop
- **Night consolidation** — Mneme agent reviews and organizes your memory while you sleep
- **Multi-agent hub** — spin up specialized agents in Telegram forum topics
- **MD-based personality** — customize behavior by editing Markdown files, no code changes
- **MCP Gateway** — optional integrations (WhatsApp, Gmail, web browsing, and more)
- **REST API** — `/api/chat` endpoint for external automations
- **Single-user, self-hosted** — designed for one person, runs on your hardware

## Quick Start

### Option A: Docker (recommended)

```bash
git clone https://github.com/jfikrat/cobrain.git
cd cobrain
cp .env.example .env
# Edit .env with your credentials (see Configuration below)
docker compose up -d
```

### Option B: Bare metal

Requires [Bun](https://bun.sh) v1.3+

```bash
git clone https://github.com/jfikrat/cobrain.git
cd cobrain
bun install
cp .env.example .env
# Edit .env with your credentials
bun run start
```

## Configuration

Three values are required in your `.env` file:

| Variable | How to get it |
|----------|--------------|
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) on Telegram, create a new bot |
| `MY_TELEGRAM_ID` | Message [@userinfobot](https://t.me/userinfobot) on Telegram, it replies with your ID |
| `ANTHROPIC_API_KEY` | Sign up at [console.anthropic.com](https://console.anthropic.com) |

See [.env.example](.env.example) for all available options.

## Architecture

```
User Message → Telegram Bot → TelegramRouter
  ├─ Forum topic? → Hub Agent (own mind files + session)
  └─ Direct chat? → Cortex (Claude Agent SDK)
                       ├─ System prompt: mind/*.md
                       ├─ Tools: memory, telegram, MCP gateway
                       └─ Memory: facts.md + events.md

BrainLoop (autonomous)
  ├─ fastTick (30s): reminders, agent heartbeats, inbox processing
  └─ slowTick (5min): proactive behaviors, Mneme trigger
```

### Core Components

| Component | What it does |
|-----------|-------------|
| **Cortex** | Main AI agent — handles conversations and autonomous tasks |
| **BrainLoop** | Autonomous scheduler — triggers reminders, proactive behaviors |
| **Mneme** | Night agent — consolidates and archives memory at 3am |
| **Hub Agents** | Specialized agents in Telegram forum topics |
| **MCP Gateway** | Optional bridge to external services |

### Mind Files

Cobrain's personality and behavior are defined entirely in Markdown files at `~/.cobrain/{userId}/mind/`:

| File | Purpose |
|------|---------|
| `identity.md` | Who the assistant is |
| `capabilities.md` | Available tools and skills |
| `rules.md` | Behavioral constraints |
| `behaviors.md` | Proactive behavior schedules |
| `memory.md` | Memory access instructions |
| `responses.md` | Response format and suggestions |
| `user.md` | User preferences |
| `contacts.md` | Important contacts |
| `inbox.md` | Autonomous message handling |

Edit these files to customize the assistant without touching code. Default templates are in `src/mind-defaults/`.

## Project Structure

```
src/
├── agent/          # Claude Agent SDK integration, tools, hooks
├── agents/         # Hub agent registry and seed templates
├── brain/          # Message orchestration, event store
├── channels/       # Telegram handlers and routing
├── memory/         # File-based + SQLite memory
├── mind-defaults/  # Default mind file templates
├── mneme/          # Night memory consolidation agent
├── services/       # BrainLoop, reminders, inbox, heartbeat
├── i18n/           # Localization (en, tr)
└── utils/          # Helpers
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Show available commands |
| `/status` | Bot status and stats |
| `/clear` | Reset conversation |
| `/mode` | Change tool permission mode |
| `/model` | Switch AI model (Opus/Sonnet) |
| `/lang` | Switch language (en/tr) |
| `/restart` | Restart the bot |

## Optional: MCP Servers

Add any [MCP server](https://modelcontextprotocol.io/servers) by creating `~/.cobrain/mcp-servers.json`:

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"]
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "ghp_xxx" }
  }
}
```

Any stdio-compatible MCP server works. Cobrain loads them automatically on startup. Without custom MCP servers, Cobrain works as a standalone assistant with memory, reminders, and autonomous behaviors.

## Optional: Multi-Agent Hub

Create a Telegram forum group, set `COBRAIN_HUB_ID` to the group ID, and Cobrain will route topic messages to specialized agents. Each agent gets its own mind files and session.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript |
| AI | [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) |
| Telegram | [grammY](https://grammy.dev) |
| Database | SQLite (bun:sqlite) + Markdown files |
| Voice | Gemini API (optional) |

## Scripts

```bash
bun run start       # Production
bun run dev         # Development with hot reload
bun test            # Run tests
bun run typecheck   # Type check
```

## License

MIT

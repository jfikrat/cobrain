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

## Prerequisites

| Requirement | Why |
|-------------|-----|
| A server or machine that stays on | Cobrain runs continuously for autonomous features |
| [Bun](https://bun.sh) v1.3+ or [Docker](https://docker.com) | Runtime |
| A Telegram account | To chat with your bot |
| Anthropic API key or Claude Code login | AI backend |

## Quick Start

### One-command setup with Claude Code

If you have [Claude Code](https://claude.com/claude-code) installed, paste this prompt:

> Clone https://github.com/jfikrat/cobrain.git and set it up. Install Bun if needed, run bun install, create .env from .env.example, then ask me for my Telegram bot token and user ID. You're already authenticated — the Agent SDK will use your OAuth token. Once .env is ready, start it with bun run start.

Claude Code will handle the rest — clone, install, configure, and start.

### Manual setup

<details>
<summary>Step-by-step instructions</summary>

#### 1. Get your Telegram credentials

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → save the **bot token**
2. Message [@userinfobot](https://t.me/userinfobot) on Telegram → it replies with your **user ID**

#### 2. Set up authentication (pick one)

Cobrain is built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) and supports two auth methods:

| Method | Setup |
|--------|-------|
| **Claude Code OAuth** (recommended) | Run `claude login` on your server — the Agent SDK picks up the token automatically |
| **API Key** | Set `ANTHROPIC_API_KEY` in `.env` — get a key at [console.anthropic.com](https://console.anthropic.com) |

#### 3. Install and run

**Option A: Docker**

```bash
git clone https://github.com/jfikrat/cobrain.git
cd cobrain
cp .env.example .env
# Edit .env — set TELEGRAM_BOT_TOKEN and MY_TELEGRAM_ID
docker compose up -d
```

**Option B: Bare metal**

```bash
curl -fsSL https://bun.sh/install | bash   # install Bun if needed
git clone https://github.com/jfikrat/cobrain.git
cd cobrain
bun install
cp .env.example .env
# Edit .env — set TELEGRAM_BOT_TOKEN and MY_TELEGRAM_ID
bun run start
```

#### 4. Start chatting

Open Telegram, find your bot, and send a message. That's it — Cobrain will respond with memory, tools, and autonomous behaviors ready to go.

</details>

## Configuration

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

Run specialized agents in Telegram forum topics — each with its own personality, tools, and memory.

### Setup

1. **Create a supergroup** in Telegram and enable **Topics** (Group Settings → Topics)
2. **Add your bot** to the group and make it **admin** (with "Manage Topics" permission)
3. **Get the group ID** — send a message in the group, then check `https://api.telegram.org/bot<TOKEN>/getUpdates` and look for `chat.id` (it will be a negative number)
4. **Set the env var** in `.env`:
   ```
   COBRAIN_HUB_ID=-100xxxxxxxxxx
   ```
5. **Restart Cobrain** and send a message in the bot's DM:
   > "Create a code agent called Kod"

   Cobrain will automatically:
   - Create a forum topic in the group
   - Scaffold mind files (`identity.md`, `rules.md`, `capabilities.md`, `behaviors.md`)
   - Register the agent with its own session

### Available agent types

| Type | Seed template | Best for |
|------|--------------|----------|
| `code` | Coding tools, Bash, file ops | Development, debugging |
| `research` | Web search, firecrawl | Research, analysis |
| `whatsapp` | WhatsApp gateway | Monitoring and replying to DMs |
| `general` | Basic tools | Everything else |
| `custom` | General (customized after creation) | Domain-specific agents (health, crypto, etc.) |

After creating a `custom` agent, Cobrain will edit its mind files to match the agent's purpose. You can also edit them manually at `~/.cobrain/users/<id>/agents/<name>/mind/`.

### Per-agent model

Each agent can use a different AI model. Send `/model` inside a topic to switch that agent between Opus and Sonnet.

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

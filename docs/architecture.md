# Architecture

This document describes the current Cobrain runtime. The product is centered on Telegram plus a small HTTP API for trusted integrations.

## Overview

```text
Telegram User        External Agent / Automation
     |                         |
     v                         v
┌──────────────┐        ┌────────────────┐
│ Telegram Bot │        │ Minimal HTTP   │
│ grammy       │        │ API (Bun)      │
└──────┬───────┘        └────────┬───────┘
       |                         |
       └──────────────┬──────────┘
                      v
             ┌──────────────────┐
             │ Brain / Agent    │
             │ orchestration    │
             └────────┬─────────┘
                      v
             ┌──────────────────┐
             │ Tools, services, │
             │ memory, reminders│
             └────────┬─────────┘
                      v
             ┌──────────────────┐
             │ SQLite + files   │
             └──────────────────┘
```

Primary interfaces:

- Telegram for interactive user conversations and approvals
- HTTP API for `/api/chat`, `/api/report`, and memory endpoints
- Optional external integrations through MCP gateway services and specialized agents

## Runtime Entry Points

- `src/index.ts` validates configuration and bootstraps normal startup.
- `src/startup.ts` starts the Telegram bot, API server, heartbeat monitor, BrainLoop, and optional hub routing.
- `src/api-server.ts` exposes the minimal HTTP API.

## Module Layout

```text
src/
├── index.ts
├── startup.ts
├── api-server.ts
├── config.ts
├── constants.ts
├── agent/
│   ├── chat.ts
│   ├── hooks.ts
│   ├── message-builder.ts
│   ├── mcp-servers.ts
│   ├── permissions.ts
│   ├── prompts.ts
│   └── tools/
│       ├── agent-loop.ts
│       ├── memory.ts
│       └── telegram.ts
├── agents/
│   ├── hub-context.ts
│   ├── interaction-log.ts
│   ├── registry.ts
│   └── seed/
├── brain/
│   ├── index.ts
│   ├── event-store.ts
│   └── projections.ts
├── channels/
│   ├── telegram.ts
│   ├── telegram-commands.ts
│   ├── telegram-callbacks.ts
│   ├── telegram-helpers.ts
│   ├── telegram-messages.ts
│   └── telegram-router.ts
├── i18n/
├── memory/
│   ├── file-memory.ts
│   └── sqlite.ts
├── mneme/
├── services/
│   ├── brain-loop.ts
│   ├── expectations.ts
│   ├── heartbeat.ts
│   ├── inbox.ts
│   ├── interaction-tracker.ts
│   ├── mood-tracking.ts
│   ├── proactive.ts
│   ├── reminders.ts
│   ├── scheduler.ts
│   ├── session-state.ts
│   ├── task-queue.ts
│   ├── transcribe.ts
│   └── user-manager.ts
├── types/
└── utils/
```

## Request Flow

### Telegram

1. Telegram update enters `src/channels/telegram.ts`.
2. Commands, callbacks, and message handlers route through the Telegram submodules.
3. Authorized requests enter the main chat flow in `src/agent/chat.ts`.
4. The agent can call MCP-backed tools, read memory, and update user state.
5. Responses are sent back to Telegram and persisted in the per-user database.

### HTTP API

1. Request hits `src/api-server.ts`.
2. `Authorization: Bearer <COBRAIN_API_KEY>` is checked for `/api/*`.
3. Route-specific logic dispatches to chat, inbox, or memory operations.
4. JSON or plain-text response is returned to the caller.

## Storage Model

Cobrain separates global state from per-user state.

### Global Database

Stored at `~/.cobrain/cobrain.db` by default.

Main tables:

- `users`
- `scheduled_tasks`
- `task_queue`
- `brain_events`

### Per-User Database

Stored at `~/.cobrain/users/<telegram_id>/cobrain.db`.

Main tables:

- `messages`
- `sessions`
- `preferences`
- `goals`
- `reminders`

Long-term narrative memory is stored separately through `src/memory/file-memory.ts`.

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Application runtime |
| Language | TypeScript | Type-safe server code |
| LLM | Claude | Main assistant model |
| Speech | Gemini | Optional transcription |
| Telegram | grammy + runner | Bot transport |
| HTTP API | Bun.serve | Minimal integration server |
| Storage | SQLite + file-based memory | Persistent user state |

## Design Notes

### Telegram-First UX

Telegram is the only built-in user-facing channel. There is no bundled browser frontend.

### Minimal API Surface

The HTTP server is intentionally small:

- `GET /health`
- `POST /api/chat`
- `POST /api/report`
- `GET /api/memory/recall`
- `POST /api/memory/remember`

### Per-User Isolation

Each Telegram user gets an isolated folder, database, uploads directory, and agent workspace.

### Tool-Gated Execution

Agent actions are mediated by permission modes and MCP tooling. Telegram remains the approval surface when user confirmation is needed.

## Security Considerations

1. Only `MY_TELEGRAM_ID` is authorized for direct bot usage.
2. `/api/*` routes require `COBRAIN_API_KEY`.
3. State is stored per user to limit accidental cross-user access.
4. Reverse proxy controls such as TLS and rate limiting should be added outside the app when exposing the API.

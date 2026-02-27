# Architecture

This document describes Cobrain's system architecture, module organization, and data flow.

## Overview

Cobrain is a personal AI assistant built with a modular architecture that supports multiple communication channels (Telegram, WhatsApp, Web UI) while maintaining a unified memory and persona system per user.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Communication Layer                       │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────┐   │
│  │  Telegram   │   │  WhatsApp   │   │      Web UI         │   │
│  │  (grammy)   │   │  (Baileys)  │   │  (HTTP + WebSocket) │   │
│  └──────┬──────┘   └──────┬──────┘   └──────────┬──────────┘   │
└─────────┼─────────────────┼──────────────────────┼──────────────┘
          │                 │                      │
          └─────────────────┼──────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Brain Layer                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Agent Chat Engine                     │   │
│  │           (Claude Agent SDK + MCP Tools)                 │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                    │
│  ┌──────────────────────────┼──────────────────────────────┐   │
│  │           ┌──────────────┴──────────────┐               │   │
│  │     ┌─────┴─────┐   ┌─────────┐   ┌─────┴─────┐        │   │
│  │     │  Memory   │   │ Persona │   │   Goals   │        │   │
│  │     │  Tools    │   │  Tools  │   │   Tools   │        │   │
│  │     └───────────┘   └─────────┘   └───────────┘        │   │
│  │                    MCP Tool Servers                     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Services Layer                            │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────────┐   │
│  │  Persona  │ │  Memory   │ │   Goals   │ │   Scheduler   │   │
│  │  Service  │ │  Service  │ │  Service  │ │  & TaskQueue  │   │
│  └───────────┘ └───────────┘ └───────────┘ └───────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Storage Layer                             │
│  ┌──────────────────────┐   ┌──────────────────────────────┐   │
│  │    Global Database   │   │    Per-User Databases        │   │
│  │    (cobrain.db)      │   │    (~/.cobrain/user_<id>/)   │   │
│  └──────────────────────┘   └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
src/
├── index.ts                 # Application entry point
├── config.ts                # Configuration (Zod validated)
│
├── agent/                   # Claude Agent SDK integration
│   ├── chat.ts              # Main agent chat logic
│   ├── prompts.ts           # System prompt generation
│   ├── permissions.ts       # Tool approval system
│   └── tools/               # MCP tool servers
│       ├── memory.ts        # remember, recall, memory_stats
│       ├── goals.ts         # goals and reminders
│       ├── persona.ts       # persona management
│       └── gdrive.ts        # Google Drive integration
│
├── brain/                   # AI orchestration
│   └── index.ts             # Per-user memory + agent routing
│
├── channels/                # Communication protocols
│   └── telegram.ts          # Telegram bot (grammy)
│
├── memory/                  # Memory subsystem
│   ├── sqlite.ts            # SQLite persistence (message history, sessions)
│   └── file-memory.ts       # Markdown-based long-term memory (facts.md + events.md)
│
├── services/                # Business logic
│   ├── persona.ts           # Persona management
│   ├── persona-evolution.ts # Auto-evolution triggers
│   ├── user-manager.ts      # Per-user folder/DB management
│   ├── goals.ts             # Goals and reminders
│   ├── scheduler.ts         # Cron-based scheduling
│   ├── task-queue.ts        # Background task processing
│   ├── proactive.ts         # Autonomous orchestration
│   ├── whatsapp.ts          # WhatsApp client (Baileys)
│   ├── whatsapp-db.ts       # WhatsApp persistence
│   └── notifier.ts          # Telegram notifications
│
├── types/                   # TypeScript interfaces
│   ├── index.ts             # Central re-export
│   ├── persona.ts           # Persona interfaces
│   ├── autonomous.ts        # Goals, reminders, tasks
│   └── user.ts              # User profile types
│
├── utils/                   # Helpers
│   ├── tool-response.ts     # MCP response formatting
│   └── user-cache.ts        # User-based caching
│
└── web/                     # Web UI
    ├── server.ts            # Bun.serve HTTP/WebSocket
    ├── websocket.ts         # WebSocket handlers
    ├── auth.ts              # Token authentication
    └── public/              # React frontend
        ├── app.tsx          # Main React app
        ├── index.html       # HTML entry point
        ├── components/      # React components
        ├── hooks/           # Custom React hooks
        ├── styles/          # Tailwind CSS
        ├── types/           # Frontend types
        └── utils/           # Frontend utilities
```

## Data Flow

### Message Processing

```
User Input → Channel → Brain → Agent SDK → Claude API
                ↓           ↑
           User DB ←────────┤
                            │
                   ┌────────┴────────┐
                   │   MCP Tools     │
                   │  (if invoked)   │
                   └────────┬────────┘
                            │
                            ▼
             Tool Result → Agent SDK → Response
                            │
                            ▼
              Streaming → Channel → User
```

### Detailed Flow

1. **User sends message** via Telegram, WhatsApp, or Web UI
2. **Channel layer** authenticates user and routes to Brain
3. **Brain layer** retrieves user context (history, memories, persona)
4. **Agent SDK** constructs prompt with system instructions
5. **Claude API** processes and may invoke MCP tools
6. **Tool servers** execute actions (memory, goals, persona, etc.)
7. **Response streams** back through channel to user
8. **Storage layer** persists conversation and updates

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun v1.3.5+ | Fast JavaScript runtime |
| Language | TypeScript 5 | Type-safe development |
| LLM | Claude (Agent SDK) | Primary AI model |
| Database | SQLite (bun:sqlite) | Persistent storage |
| Long-term Memory | FileMemory (Markdown) | facts.md + events.md |
| Telegram | grammy + runner | Bot framework |
| WhatsApp | Baileys | Unofficial WA client |
| HTTP/WS | Bun.serve | Built-in web server |
| Frontend | React 19 | Web UI components |
| Styling | Tailwind CSS 3 | Utility-first CSS |

## Database Schema

### Global Database (`~/.cobrain/cobrain.db`)

```sql
-- Registered users
CREATE TABLE users (
  id INTEGER PRIMARY KEY,          -- Telegram user ID
  created_at DATETIME,
  last_seen_at DATETIME,
  folder_path TEXT NOT NULL,       -- Path to user's data folder
  settings TEXT DEFAULT '{}'       -- JSON user preferences
);

-- Scheduled tasks (cron-based)
CREATE TABLE scheduled_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  task_type TEXT,                  -- daily_summary, goal_check, etc.
  schedule TEXT,                   -- Cron expression
  config TEXT,                     -- JSON configuration
  enabled INTEGER DEFAULT 1,
  last_run_at DATETIME,
  next_run_at DATETIME
);

-- Background job queue
CREATE TABLE task_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  task_type TEXT,
  payload TEXT,                    -- JSON payload
  priority INTEGER DEFAULT 5,
  status TEXT,                     -- pending, running, completed, failed
  created_at DATETIME,
  started_at DATETIME,
  completed_at DATETIME,
  error TEXT
);
```

### Per-User Database (`~/.cobrain/user_<id>/cobrain.db`)

```sql
-- Web UI conversations
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,             -- UUID
  title TEXT,
  created_at INTEGER,              -- Unix timestamp
  updated_at INTEGER,
  is_deleted INTEGER DEFAULT 0
);

-- Messages within conversations
CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  role TEXT,                       -- user, assistant
  content TEXT,
  tool_uses TEXT,                  -- JSON array of tool calls
  timestamp INTEGER
);

-- Chat history (all channels)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT,
  content TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  metadata TEXT,                   -- JSON (memories used, etc.)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Goals
CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',    -- active, completed, abandoned, paused
  priority INTEGER DEFAULT 5,      -- 0-10
  due_date DATE,
  progress REAL DEFAULT 0,         -- 0.0-1.0
  metadata TEXT,
  created_at DATETIME,
  updated_at DATETIME
);

-- Reminders
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT,
  trigger_at DATETIME,
  repeat_pattern TEXT,             -- Cron pattern for recurring
  status TEXT DEFAULT 'pending',   -- pending, sent, snoozed, cancelled
  created_at DATETIME
);

-- Persona configuration
CREATE TABLE personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER,
  identity TEXT,                   -- JSON
  voice TEXT,                      -- JSON
  behavior TEXT,                   -- JSON
  boundaries TEXT,                 -- JSON
  user_context TEXT,               -- JSON
  is_active INTEGER DEFAULT 1,
  created_at DATETIME,
  updated_at DATETIME
);

-- Persona change history
CREATE TABLE persona_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER,
  version INTEGER,
  change_type TEXT,                -- manual, auto-evolution
  changed_fields TEXT,             -- JSON array
  previous_values TEXT,            -- JSON
  new_values TEXT,                 -- JSON
  reason TEXT,
  triggered_by TEXT,               -- user, system
  created_at DATETIME
);

-- Semantic memories
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,                       -- episodic, semantic, procedural
  content TEXT,
  summary TEXT,
  tags TEXT,                       -- JSON array
  importance REAL DEFAULT 0.5,     -- 0.0-1.0
  access_count INTEGER DEFAULT 0,
  last_accessed_at DATETIME,
  source TEXT,                     -- telegram, web, whatsapp
  source_ref TEXT,
  metadata TEXT,                   -- JSON
  created_at DATETIME,
  expires_at DATETIME              -- For episodic memories
);
```

## Key Design Decisions

### Per-User Isolation

Each user has their own:
- Data folder (`~/.cobrain/user_<id>/`)
- SQLite database
- Memory store
- Persona configuration
- Conversation history

This ensures complete data isolation and allows independent evolution of each user's AI assistant.

### Agent SDK vs CLI Fallback

Cobrain supports two modes:
1. **Agent SDK** (default): Direct API integration with Claude
2. **CLI fallback**: tmux-based Claude CLI sessions

The CLI fallback exists for scenarios where the Agent SDK is unavailable.

### MCP Tool Architecture

Tools are implemented as MCP (Model Context Protocol) servers:
- Each tool category has its own server
- Tools are registered with the Agent SDK
- Permission system gates dangerous operations
- Tools return structured responses

### Streaming-First Design

All AI responses use streaming:
- Better user experience (see response as it's generated)
- WebSocket for Web UI real-time updates
- Telegram sends typing indicators during generation

## Security Considerations

1. **User Authorization**: Only allowed Telegram user IDs can interact
2. **Token Authentication**: Web UI uses time-limited tokens (24h)
3. **Permission Modes**: Three levels (strict, smart, yolo) for tool approval
4. **Data Isolation**: Per-user databases prevent cross-user access
5. **No Secrets in Logs**: Sensitive data is filtered from logs

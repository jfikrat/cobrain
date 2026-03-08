# Configuration

Cobrain reads configuration from environment variables. Validation happens at startup in `src/config.ts` using Zod.

## Required Variables

| Variable | Type | Description |
|----------|------|-------------|
| `TELEGRAM_BOT_TOKEN` | string | Bot token from [@BotFather](https://t.me/BotFather) |
| `MY_TELEGRAM_ID` | number | Telegram user ID allowed to use the bot |

## Core Runtime

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `COBRAIN_BASE_PATH` | string | `~/.cobrain` | Base directory for Cobrain data |
| `MAX_HISTORY` | number | `10` | Message history kept in active chat context |
| `PERMISSION_MODE` | `strict \| smart \| yolo` | `smart` | Tool approval behavior |
| `ENABLE_AUTONOMOUS` | boolean | `true` | Enables background autonomy features |

## Models

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ANTHROPIC_API_KEY` | string | - | Claude API key |
| `AGENT_MODEL` | string | `claude-sonnet-4-6` | Primary chat model |
| `MAX_AGENT_TURNS` | number | `20` | Max turns for a single agent run |
| `GEMINI_API_KEY` | string | `""` | Optional Gemini key for transcription |
| `TRANSCRIPTION_MODEL` | string | `gemini-3.1-flash-lite-preview` | Speech-to-text model |

## API Server

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `API_PORT` | number | `3000` | Port for the minimal HTTP API |
| `COBRAIN_API_KEY` | string | `""` | Bearer token required for `/api/*` routes |

## Heartbeat And Brain Loop

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ENABLE_HEARTBEAT_MONITORING` | boolean | `true` | Enables runtime heartbeat checks |
| `HEARTBEAT_STALE_AFTER_MS` | number | `120000` | Marks a component stale after this interval |
| `HEARTBEAT_LOG_INTERVAL_MS` | number | `30000` | Heartbeat log cadence |
| `BRAIN_LOOP_FAST_TICK_MS` | number | `5000` | Fast tick interval for the BrainLoop |
| `BRAIN_LOOP_SLOW_TICK_MS` | number | `300000` | Slow tick interval for the BrainLoop |
| `BRAIN_LOOP_KNOWLEDGE_PATH` | string | `knowledge` | Knowledge directory used by the BrainLoop |

## Feature Flags And Agent State

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `FF_BRAIN_EVENTS` | boolean | `true` | Enables append-only brain event logging |
| `FF_SESSION_STATE` | boolean | `true` | Enables session-state persistence |
| `FF_MEMORY_CONSOLIDATION` | boolean | `true` | Enables memory consolidation routines |
| `CORTEX_EXPECTATION_TIMEOUT_MS` | number | `1800000` | Expectation timeout window |
| `CORTEX_EXPECTATION_CLEANUP_INTERVAL_MS` | number | `60000` | Cleanup interval for expired expectations |

## Integration Paths

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MCP_SERVERS_HOME` | string | `~/mcp-servers` | Root directory for local MCP servers |
| `LOG_CHANNEL_ID` | number | - | Optional Telegram channel for autonomy logs |
| `COBRAIN_HUB_ID` | number | - | Optional Telegram forum chat for multi-agent routing |

## Permission Modes

### `strict`

All tool usage requires approval.

### `smart`

Read-only and low-risk actions are auto-approved. Destructive or privileged actions still require confirmation.

### `yolo`

All tool usage is auto-approved. Use only in trusted environments.

## Example Configurations

### Minimal Telegram Setup

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### Telegram Plus HTTP API

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

COBRAIN_BASE_PATH=/home/user/.cobrain
API_PORT=3000
COBRAIN_API_KEY=replace-me

AGENT_MODEL=claude-sonnet-4-6
GEMINI_API_KEY=
TRANSCRIPTION_MODEL=gemini-3.1-flash-lite-preview

ENABLE_AUTONOMOUS=true
ENABLE_HEARTBEAT_MONITORING=true
PERMISSION_MODE=smart
```

### Development Setup

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

API_PORT=3000
PERMISSION_MODE=yolo
```

## Data Layout

Cobrain creates this structure inside `COBRAIN_BASE_PATH`:

```text
~/.cobrain/
├── cobrain.db               # Global database
└── users/
    └── <telegram_id>/
        ├── cobrain.db       # Per-user database
        ├── uploads/         # User uploads
        └── agent/           # Agent work area
```

## Runtime Overrides

Some settings can be changed during runtime and persisted in the user record:

| Setting | Command |
|---------|---------|
| Permission mode | `/mode` |
| Language | `/lang` |

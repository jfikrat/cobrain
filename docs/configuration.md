# Configuration

Cobrain is configured through environment variables. All variables are validated at startup using Zod schema validation.

## Environment Variables

### Required Variables

| Variable | Type | Description |
|----------|------|-------------|
| `TELEGRAM_BOT_TOKEN` | string | Bot token from [@BotFather](https://t.me/BotFather) |
| `MY_TELEGRAM_ID` | number | Your Telegram user ID (get from @userinfobot) |
| `ANTHROPIC_API_KEY` | string | Anthropic API key for Claude access |

### Storage

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `COBRAIN_BASE_PATH` | string | `~/.cobrain` | Base directory for user data |

### AI Models

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `AGENT_MODEL` | string | `claude-opus-4-5-20251101` | Main chat model (Claude Opus 4.5) |
| `USE_AGENT_SDK` | boolean | `true` | Use Claude Agent SDK |
| `GEMINI_API_KEY` | string | - | Gemini API key for voice transcription |
| `TRANSCRIPTION_MODEL` | string | `gemini-3-flash-preview` | Voice transcription model |

### Memory Settings

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_HISTORY` | number | `10` | Messages to keep in conversation context |
| `MAX_MEMORY_AGE_DAYS` | number | `90` | Days to retain episodic memories |

### Living Assistant

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ENABLE_HEARTBEAT_MONITORING` | boolean | `true` | Enable proactive awareness |
| `HEARTBEAT_LOG_INTERVAL_MS` | number | `30000` | Awareness loop interval (ms) |
| `HEARTBEAT_STALE_AFTER_MS` | number | `120000` | Stale heartbeat threshold (ms) |

### Web UI

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ENABLE_WEB_UI` | boolean | `true` | Enable Web UI server |
| `WEB_PORT` | number | `3000` | Web server port |
| `WEB_URL` | string | `http://localhost:3000` | Public URL for Web UI links |

### Permissions

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PERMISSION_MODE` | enum | `smart` | Tool approval mode: `strict`, `smart`, or `yolo` |

## Permission Modes

Cobrain has three permission modes that control how tool usage is approved:

### Strict Mode

```env
PERMISSION_MODE=strict
```

- **All tool usage requires explicit approval**
- Most secure but requires frequent interaction
- Recommended for sensitive environments

### Smart Mode (Default)

```env
PERMISSION_MODE=smart
```

- **Safe tools are auto-approved**
- Dangerous operations require approval
- Balanced security and convenience

**Auto-approved (safe):**
- Read, Glob, Grep
- WebSearch, WebFetch
- Memory read operations

**Require approval (dangerous):**
- File Write/Edit operations
- Delete operations (rm, rmdir)
- System commands (sudo, kill)
- Database modifications (DROP, TRUNCATE)

### Yolo Mode

```env
PERMISSION_MODE=yolo
```

- **All tools are auto-approved**
- Use only in trusted environments
- Not recommended for production

## Example Configurations

### Minimal Setup

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### Full-Featured Setup

```env
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Storage
COBRAIN_BASE_PATH=/home/user/.cobrain

# AI Models
USE_AGENT_SDK=true
AGENT_MODEL=claude-opus-4-5-20251101
GEMINI_API_KEY=xxxxx
TRANSCRIPTION_MODEL=gemini-3-flash-preview

# Memory
MAX_HISTORY=15
MAX_MEMORY_AGE_DAYS=180

# Features
ENABLE_AUTONOMOUS=true
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=https://cobrain.example.com

# Living Assistant
ENABLE_HEARTBEAT_MONITORING=true
HEARTBEAT_LOG_INTERVAL_MS=30000

# Security
PERMISSION_MODE=smart
```

### Development Setup

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Development settings
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=http://localhost:3000
PERMISSION_MODE=yolo
```

## LLM Architecture

Cobrain uses multiple LLMs for different tasks:

| Model | Usage | Purpose |
|-------|-------|---------|
| Claude Opus 4.5 | Main Chat | Agent SDK, tool orchestration, reasoning |
| Claude Haiku 4.5 | Memory | Tag extraction, summarization, semantic ranking |
| Gemini 3 Flash | Transcription | Voice/audio to text conversion |

### Claude (Primary)

Claude is the primary LLM via the Agent SDK:

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
AGENT_MODEL=claude-opus-4-5-20251101
USE_AGENT_SDK=true
```

The Agent SDK provides:
- Streaming responses
- MCP tool integration
- Conversation management
- Token counting

### Claude Haiku (Memory)

Haiku handles memory operations automatically using the same API key:
- Memory ranking (semantic similarity)
- Tag extraction from content
- Summary generation

### Gemini (Voice - Optional)

Gemini handles voice transcription:

```env
GEMINI_API_KEY=xxxxx
TRANSCRIPTION_MODEL=gemini-3-flash-preview
```

If not configured, voice messages won't be transcribed.

## Data Directory Structure

Cobrain creates the following structure in `COBRAIN_BASE_PATH`:

```
~/.cobrain/
├── cobrain.db              # Global database (users, tasks)
└── user_<telegram_id>/     # User directory
    ├── cobrain.db          # User database (messages, goals, etc.)
    ├── memory.db           # Memory database with FTS5
    └── whatsapp/           # WhatsApp session (if enabled)
        └── auth/           # Multi-file auth state
```

## Validation

All configuration is validated at startup:

```typescript
const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  MY_TELEGRAM_ID: z.coerce.number().min(1),
  COBRAIN_BASE_PATH: z.string().default('~/.cobrain'),
  // ... more fields
});
```

Invalid configuration will cause the application to exit with an error message indicating which fields are invalid.

## Runtime Configuration

Some settings can be changed at runtime via Telegram commands:

| Setting | Command |
|---------|---------|
| Permission mode | `/mode` |
| Persona settings | `/persona` |

These changes persist in the user's database.

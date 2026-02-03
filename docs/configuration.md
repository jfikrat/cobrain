# Configuration

Cobrain is configured through environment variables. All variables are validated at startup using Zod schema validation.

## Environment Variables

### Required Variables

| Variable | Type | Description |
|----------|------|-------------|
| `TELEGRAM_BOT_TOKEN` | string | Bot token from [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USER_IDS` | string | Comma-separated Telegram user IDs allowed to use the bot |
| `ANTHROPIC_API_KEY` | string | Anthropic API key for Claude access |

### Storage

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `COBRAIN_BASE_PATH` | string | `~/.cobrain` | Base directory for user data |

### AI Models

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `USE_AGENT_SDK` | boolean | `true` | Use Claude Agent SDK (vs CLI fallback) |
| `OLLAMA_URL` | string | `http://localhost:11434` | Ollama server URL for embeddings |
| `EMBEDDING_MODEL` | string | `all-minilm:l6-v2` | Embedding model name (384 dimensions) |
| `CEREBRAS_API_KEY` | string | - | Cerebras API key for memory operations |
| `CEREBRAS_MODEL` | string | `gpt-oss-120b` | Cerebras model for ranking/extraction |

### Memory Settings

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_HISTORY` | number | `10` | Messages to keep in conversation context |
| `MAX_MEMORY_AGE_DAYS` | number | `90` | Days to retain episodic memories |

### Autonomous Features

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ENABLE_AUTONOMOUS` | boolean | `true` | Enable scheduler and task queue |

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
ALLOWED_USER_IDS=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### Full-Featured Setup

```env
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
ALLOWED_USER_IDS=123456789,987654321
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Storage
COBRAIN_BASE_PATH=/home/user/.cobrain

# AI Models
USE_AGENT_SDK=true
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=all-minilm:l6-v2
CEREBRAS_API_KEY=csk-xxxxx
CEREBRAS_MODEL=gpt-oss-120b

# Memory
MAX_HISTORY=15
MAX_MEMORY_AGE_DAYS=180

# Features
ENABLE_AUTONOMOUS=true
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=https://cobrain.example.com

# Security
PERMISSION_MODE=smart
```

### Development Setup

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
ALLOWED_USER_IDS=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Development settings
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=http://localhost:3000
PERMISSION_MODE=yolo
```

## LLM Providers

### Claude (Primary)

Claude is the primary LLM via the Agent SDK:

```env
ANTHROPIC_API_KEY=sk-ant-xxxxx
USE_AGENT_SDK=true
```

The Agent SDK provides:
- Streaming responses
- MCP tool integration
- Conversation management
- Token counting

### Cerebras (Optional)

Cerebras enhances memory operations:

```env
CEREBRAS_API_KEY=csk-xxxxx
CEREBRAS_MODEL=gpt-oss-120b
```

Used for:
- Memory ranking (semantic similarity)
- Tag extraction from content
- Summary generation

If not configured, fallback to keyword-based memory search.

### Ollama (Optional)

Ollama provides local embeddings:

```env
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=all-minilm:l6-v2
```

Used for:
- Vector memory search
- Semantic similarity matching

If not configured, memory uses keyword matching only.

## Data Directory Structure

Cobrain creates the following structure in `COBRAIN_BASE_PATH`:

```
~/.cobrain/
├── cobrain.db              # Global database (users, tasks)
└── user_<telegram_id>/     # Per-user directories
    ├── cobrain.db          # User database (messages, goals, etc.)
    ├── memory.db           # Memory database
    └── whatsapp/           # WhatsApp session (if enabled)
        └── auth/           # Multi-file auth state
```

## Validation

All configuration is validated at startup:

```typescript
const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_USER_IDS: z.string().transform(parseUserIds),
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

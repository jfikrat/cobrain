# Getting Started

This guide will help you set up and run Cobrain on your local machine.

## Prerequisites

Before installing Cobrain, ensure you have:

- **Bun** v1.3.5 or higher ([install guide](https://bun.sh))
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **Anthropic API Key** for Claude access
- **Ollama** (optional, for local embeddings)
- **Cerebras API Key** (optional, for enhanced memory features)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/cobrain.git
cd cobrain
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Create Environment File

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Required
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_USER_IDS=123456789,987654321
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Optional - Ollama (for local embeddings)
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=all-minilm:l6-v2

# Optional - Cerebras (for enhanced memory)
CEREBRAS_API_KEY=your_cerebras_key
CEREBRAS_MODEL=gpt-oss-120b

# Optional - Web UI
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=http://localhost:3000
```

See [Configuration](./configuration.md) for all available options.

### 4. Set Up Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token to your `.env` file
4. Send `/setcommands` to BotFather and paste:

```
start - Start the bot
help - Show available commands
status - Check bot status
web - Get Web UI link
persona - Persona settings
mode - Change permission mode
goals - Manage goals
memory - Memory operations
stats - View statistics
```

### 5. Get Your Telegram User ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your user ID
3. Add this ID to `ALLOWED_USER_IDS` in your `.env` file

### 6. Set Up Ollama (Optional)

For local embeddings support:

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the embedding model
ollama pull all-minilm:l6-v2
```

## Running Cobrain

### Development Mode

Start with hot reload:

```bash
bun run dev
```

For the Web UI with Tailwind CSS watching:

```bash
# Terminal 1: CSS watch
bun run dev:css

# Terminal 2: Server with HMR
bun run dev
```

### Production Mode

```bash
bun run start
```

## Verify Installation

1. **Start the bot**:
   ```bash
   bun run dev
   ```

2. **Check the console** for startup message:
   ```
   ╔═══════════════════════════════════════╗
   ║           C O B R A I N               ║
   ║        Personal AI Assistant          ║
   ╚═══════════════════════════════════════╝

   Version: 0.4.0
   [✓] Telegram bot started
   [✓] Web UI running on http://localhost:3000
   ```

3. **Test the Telegram bot**:
   - Open Telegram and find your bot
   - Send `/start`
   - You should receive a welcome message

4. **Test the Web UI** (if enabled):
   - Send `/web` to your Telegram bot
   - Click the link to open the Web UI
   - Send a test message

## First Conversation

Once everything is running, try these interactions:

```
You: Hello! What can you do?

Cobrain: Merhaba! Ben Cobrain, kişisel AI asistanınım.
         Şunları yapabilirim:
         - Sorularını yanıtlama
         - Bilgileri hatırlama ve hatırlatma
         - Hedeflerini takip etme
         - WhatsApp mesajlarını analiz etme
         ...
```

Set up your first reminder:

```
You: Remind me to check emails tomorrow at 9am

Cobrain: Tamam, yarın saat 09:00'da "check emails"
         hatırlatması oluşturdum.
```

## Troubleshooting

### Bot Not Responding

1. Check if your user ID is in `ALLOWED_USER_IDS`
2. Verify the bot token is correct
3. Ensure the bot is running (`bun run dev`)

### Web UI Not Loading

1. Check if `ENABLE_WEB_UI=true` in `.env`
2. Verify the port is not in use
3. Check console for errors

### Memory/Embeddings Not Working

1. Ensure Ollama is running: `ollama serve`
2. Pull the model: `ollama pull all-minilm:l6-v2`
3. Verify `OLLAMA_URL` is correct

### Database Errors

1. Check if data directory exists: `~/.cobrain/`
2. Ensure write permissions
3. Try deleting `*.db` files to reset (data will be lost)

## Next Steps

- [Configuration](./configuration.md) - Customize your setup
- [Telegram Channel](./channels/telegram.md) - Learn Telegram commands
- [Web UI](./channels/web-ui.md) - Explore Web UI features
- [Persona System](./features/persona.md) - Customize AI personality
- [Memory System](./features/memory.md) - Understand memory layers

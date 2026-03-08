# Getting Started

This guide gets Cobrain running locally with Telegram and the optional minimal HTTP API.

## Prerequisites

- [Bun](https://bun.sh) v1.3.5 or newer
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Anthropic API key
- Gemini API key only if you want voice transcription

## Installation

### 1. Clone The Repository

```bash
git clone https://github.com/yourusername/cobrain.git
cd cobrain
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Create `.env`

```bash
cp .env.example .env
```

Minimal example:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx
API_PORT=3000
```

See [Configuration](./configuration.md) for the full list.

### 4. Configure Telegram Commands

Create your bot with BotFather, then send `/setcommands` and paste:

```text
start - Start the bot
help - Show available commands
status - Show bot status
clear - Reset the current session
restart - Restart the bot
mode - Change permission mode
lang - Change language
```

### 5. Get Your Telegram User ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy the numeric ID it returns
3. Set that value as `MY_TELEGRAM_ID`

## Running Cobrain

Development:

```bash
bun run dev
```

Production:

```bash
bun run start
```

## Verify Installation

1. Start Cobrain with `bun run dev`.
2. Confirm the console shows the Telegram bot and API server starting.
3. Open Telegram and send `/start` to your bot.
4. Check the health endpoint:

```bash
curl http://localhost:3000/health
```

Optional API check when `COBRAIN_API_KEY` is set:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $COBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}'
```

## Troubleshooting

### Bot Not Responding

1. Verify `MY_TELEGRAM_ID` matches your Telegram account.
2. Verify `TELEGRAM_BOT_TOKEN` is correct.
3. Check the terminal for startup or API errors.

### API Not Reachable

1. Confirm `API_PORT` matches the port you are calling.
2. Check whether another process is already using that port.
3. Make sure `COBRAIN_API_KEY` is set if you are calling `/api/*`.

### Database Errors

1. Check that `COBRAIN_BASE_PATH` is writable.
2. Inspect `~/.cobrain/` for existing database files.
3. If this is a disposable local setup, remove the local database files and restart.

## Next Steps

- [Configuration](./configuration.md) for runtime options
- [Telegram Channel](./channels/telegram.md) for command behavior
- [HTTP API](./api/http.md) for integration endpoints
- [Architecture](./architecture.md) for the current module layout

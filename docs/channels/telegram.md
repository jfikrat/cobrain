# Telegram Channel

Telegram is the primary communication channel for Cobrain. It uses the [grammy](https://grammy.dev) framework with the runner extension for reliable message handling.

## Setup

### 1. Create a Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name (e.g., "My Cobrain")
4. Choose a username (must end in `bot`, e.g., `my_cobrain_bot`)
5. Copy the token provided

### 2. Configure Environment

```env
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
ALLOWED_USER_IDS=123456789,987654321
```

### 3. Set Bot Commands

Send to @BotFather:
```
/setcommands
```

Then paste:
```
start - Start the bot
help - Show available commands
status - Check bot and WhatsApp status
scan - List pending WhatsApp messages
reply - Reply to WhatsApp message
persona - Persona settings
mode - Change permission mode
web - Get Web UI link
stats - View usage statistics
memory - Memory operations
goals - Manage goals
```

## Commands

### `/start`

Initializes the bot and displays a welcome message.

```
Welcome to Cobrain - Your Personal AI Assistant!

Use /help to see available commands.
```

### `/help`

Lists all available commands with descriptions.

### `/status`

Shows current bot status and WhatsApp connection state.

```
🤖 Cobrain Status

Version: 0.4.0
Uptime: 2 hours, 15 minutes

WhatsApp: ✅ Connected
Pending Messages: 3
```

### `/scan`

Lists pending WhatsApp messages that need attention.

```
📱 Pending WhatsApp Messages

1. Ahmet (2 hours ago)
   "Yarınki toplantı hala geçerli mi?"

2. Work Group (30 min ago)
   "Rapor hazır mı?"

Reply with: /reply <name> <message>
```

### `/reply <name> <message>`

Sends a reply via WhatsApp.

```
/reply Ahmet Evet, saat 10'da görüşürüz
```

Response:
```
✅ Message sent to Ahmet
```

### `/persona`

Opens persona settings menu with inline keyboard:

- **Tone**: samimi, resmi, teknik, espirili, destekleyici
- **Verbosity**: brief, normal, detailed
- **Emoji Usage**: none, minimal, moderate, frequent
- **Address Form**: sen, siz

### `/mode`

Changes the permission mode with inline keyboard:

- **Strict**: All tools require approval
- **Smart**: Safe tools auto-approved
- **Yolo**: All tools auto-approved

### `/web`

Generates a Web UI access link valid for 24 hours.

```
🌐 Web UI Access

Click to open: https://cobrain.example.com?token=abc123...

⏰ Link expires in 24 hours
```

### `/stats`

Shows usage statistics.

```
📊 Statistics

Messages: 1,234
Tokens Used: 456,789
Cost: $12.34

Memory:
- Episodic: 89
- Semantic: 45
- Procedural: 12

Active Goals: 5
Pending Reminders: 3
```

### `/memory`

Memory management menu:

- **Stats**: Show memory statistics
- **Search**: Search memories
- **Prune**: Clean expired memories

### `/goals`

Goals management menu:

- **List**: Show all goals
- **Create**: Create new goal
- **Progress**: Update goal progress

## Direct Messages

Any message that's not a command is processed by the AI:

```
User: What's the weather like today?

Cobrain: Hava durumu bilgisi için bir araç kullanmam
         gerekiyor. İzin verir misin?
         [Approve] [Deny]
```

## Permission Approval

When tools require approval (in strict/smart modes):

```
🔧 Tool Permission Request

Tool: WebFetch
Action: Fetch weather data from weather.com

[Approve] [Deny]
```

Clicking **Approve** executes the tool. Clicking **Deny** cancels.

## Conversation Features

### Streaming Responses

Responses stream in real-time. You'll see a typing indicator while the AI generates its response.

### Context Retention

The bot maintains conversation context (last 10 messages by default). Reference previous messages naturally:

```
User: Tell me about TypeScript
Cobrain: TypeScript is a typed superset of JavaScript...

User: What about its type system?
Cobrain: Building on what I just mentioned,
         TypeScript's type system includes...
```

### Memory Integration

The AI can remember important information:

```
User: Remember that my favorite color is blue
Cobrain: I'll remember that your favorite color is blue.

[Later...]

User: What's my favorite color?
Cobrain: Your favorite color is blue.
```

## Error Handling

### Unauthorized User

If a non-allowed user tries to message:
```
⛔ Unauthorized

You are not authorized to use this bot.
Contact the administrator for access.
```

### Rate Limiting

The bot handles Telegram rate limits automatically with exponential backoff.

### Disconnection Recovery

The grammy runner automatically reconnects if the connection drops.

## Best Practices

1. **Keep Context Fresh**: Start new conversations for unrelated topics
2. **Use Commands**: Utilize `/web` for complex interactions
3. **Set Reminders**: Let Cobrain track tasks with `/goals`
4. **Customize Persona**: Adjust tone and style via `/persona`
5. **Monitor Costs**: Check usage with `/stats`

## Technical Details

### Framework

- **grammy**: Telegram Bot API framework
- **@grammyjs/runner**: Long polling with auto-reconnect
- **Conversation handling**: Per-user state management

### Message Flow

1. Message received via long polling
2. User authorization check
3. Command parsing or AI routing
4. Response streaming back to user
5. Message persistence to database

### Rate Limits

Cobrain respects Telegram's rate limits:
- 30 messages/second to same chat
- 20 messages/minute to same group
- 1 message/second to same user

The runner handles retries automatically.

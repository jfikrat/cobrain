# WhatsApp Integration

Cobrain integrates with WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web API library.

> **Note**: This is an unofficial integration. WhatsApp may change their protocol at any time, which could break this functionality.

## How It Works

Cobrain doesn't respond to WhatsApp messages directly. Instead, it:

1. **Monitors** incoming WhatsApp messages
2. **Analyzes** and summarizes pending chats
3. **Notifies** you via Telegram about important messages
4. **Sends replies** when you instruct it to

This keeps you in control while providing AI-powered assistance.

## Setup

### 1. Initial Connection

When you first start Cobrain, WhatsApp is disconnected. The bot will notify you:

```
📱 WhatsApp Status: Disconnected

To connect, a QR code will be displayed in the console.
Scan it with WhatsApp on your phone.
```

### 2. QR Code Authentication

1. Open WhatsApp on your phone
2. Go to Settings → Linked Devices
3. Tap "Link a Device"
4. Scan the QR code shown in the console

### 3. Session Persistence

Once connected, the session is saved to:
```
~/.cobrain/user_<id>/whatsapp/auth/
```

You won't need to scan the QR code again unless you log out.

## Features

### Message Monitoring

WhatsApp messages are stored locally for analysis:

```
📱 New WhatsApp Messages

Ahmet (2 min ago):
"Yarınki toplantı saat kaçta?"

Work Group (5 min ago):
"Deadline bugün, rapor hazır mı?"
```

### Telegram Commands

#### `/status`

Shows WhatsApp connection status:
```
WhatsApp: ✅ Connected
Phone: +90 555 123 4567
Pending Chats: 5
```

#### `/scan`

Lists all pending messages that need your attention:

```
📱 Pending WhatsApp Messages

Personal:
1. Ahmet (2 hours ago) - 1 message
2. Ayşe (1 hour ago) - 3 messages

Groups:
3. Work Group (30 min ago) - 5 messages
4. Family (2 hours ago) - 2 messages

Reply with: /reply <name> <message>
```

#### `/reply <name> <message>`

Sends a reply to a WhatsApp contact:

```
/reply Ahmet Toplantı saat 10'da, görüşürüz!
```

Response:
```
✅ Sent to Ahmet:
"Toplantı saat 10'da, görüşürüz!"
```

### AI-Assisted Replies

You can ask Cobrain to help compose replies:

```
User: Help me reply to Ahmet about the meeting

Cobrain: Based on Ahmet's message asking about
         tomorrow's meeting time, here's a suggested reply:

         "Merhaba Ahmet, toplantı yarın saat 10:00'da
         ofiste olacak. Gündem notlarını mail attım."

         Shall I send this? [Send] [Edit]
```

### Daily Summaries

When autonomous features are enabled, you receive daily summaries:

```
📊 Daily WhatsApp Summary

Personal Messages: 12
Group Messages: 45
Requiring Response: 3

Top Contacts:
1. Ahmet - 5 messages (waiting)
2. Work Group - 15 messages
3. Ayşe - 3 messages (waiting)

Action Items:
- Reply to Ahmet about meeting
- Check Work Group deadline discussion
```

## Message Analysis

Cobrain analyzes WhatsApp messages to:

1. **Identify Urgency**: Detects time-sensitive requests
2. **Extract Action Items**: Finds tasks and questions
3. **Summarize Threads**: Condenses long group chats
4. **Track Wait Times**: Shows how long messages are pending

Example analysis:
```
📋 Message Analysis: Ahmet

Context: Asking about tomorrow's meeting
Urgency: Medium (mentions "yarın")
Suggested Action: Confirm time and location
Wait Time: 2 hours

Recent History:
- Yesterday: Discussed project progress
- Last week: Meeting invitation
```

## Privacy & Security

### Local Storage

All WhatsApp data is stored locally:
- Messages are saved to SQLite database
- Auth credentials stay in your data folder
- No data is sent to external servers (except WhatsApp's)

### Access Control

- Only you (via Telegram) can access WhatsApp features
- Messages are isolated per user
- No automatic message forwarding

### Limitations

1. **End-to-End Encryption**: Some message types may not be fully accessible
2. **Media**: Images and files are not currently processed
3. **Groups**: Limited to text messages in groups

## Troubleshooting

### Connection Lost

If WhatsApp disconnects:
```
📱 WhatsApp Disconnected

Reason: Session expired

Attempting to reconnect...
```

The bot will auto-reconnect. If it fails repeatedly, you may need to re-scan the QR code.

### QR Code Not Showing

Check the console where Cobrain is running. The QR code is displayed there, not in Telegram.

### Messages Not Syncing

1. Check `/status` to verify connection
2. Ensure your phone has internet access
3. WhatsApp Web must remain logged in on your phone

### Rate Limiting

WhatsApp may temporarily block if too many messages are sent:
```
⚠️ WhatsApp Rate Limited

Please wait a few minutes before sending more messages.
```

## Technical Details

### Library

- **Baileys**: Unofficial WhatsApp Web API
- **Multi-device support**: Works with WhatsApp's multi-device feature
- **Socket.IO based**: Real-time message receiving

### Data Storage

```
~/.cobrain/user_<id>/
└── whatsapp/
    └── auth/
        ├── creds.json         # Authentication credentials
        ├── app-state-sync-*.json
        └── pre-key-*.json
```

### Message Types Supported

- Text messages
- Reply messages
- Group messages
- Contact messages (name extraction)

### Unsupported Features

- Media messages (images, videos, audio)
- Status updates
- Calls
- Stories/Status

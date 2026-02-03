# Web UI

The Web UI provides a browser-based chat interface for Cobrain with features like conversation management, search, and real-time streaming.

## Accessing the Web UI

### Via Telegram

1. Send `/web` to your Cobrain Telegram bot
2. Click the generated link
3. The link is valid for 24 hours

```
/web

🌐 Web UI Access

Click to open: https://cobrain.example.com?token=abc123...

⏰ Link expires in 24 hours
```

### Direct Access

If you have a valid token, access directly:
```
http://localhost:3000?token=YOUR_TOKEN
```

## Features

### Chat Interface

The main chat interface includes:

- **Message Input**: Type messages at the bottom
- **Message List**: Scrollable conversation history
- **Streaming Responses**: See AI responses as they're generated
- **Tool Indicators**: Visual feedback when AI uses tools

### Conversations

#### Multiple Conversations

Create and manage multiple conversations:

- Click **New Chat** to start a fresh conversation
- Previous conversations are saved automatically
- Switch between conversations in the sidebar

#### Conversation List

The sidebar shows all your conversations:
- Sorted by last activity
- Shows conversation title and preview
- Indicates unread or active status

#### Rename Conversations

Click on a conversation title to rename it:
```
"New Conversation" → "Project Planning"
```

#### Delete Conversations

Delete conversations from the menu. This soft-deletes the conversation (can be restored if needed).

### Search

Search across all your conversations:

1. Click the search icon in the sidebar
2. Enter your search query
3. Results show matching messages with context
4. Click a result to jump to that conversation

### Export

Export your conversations:

1. Open a conversation
2. Click the export icon
3. Choose format (Markdown, JSON)
4. Download the file

### Voice Input

Use voice-to-text for hands-free input:

1. Click the microphone icon
2. Speak your message
3. The transcribed text appears in the input
4. Edit if needed and send

> **Note**: Requires browser microphone permission

### File Upload

Upload files for AI analysis:

1. Click the attachment icon
2. Select a file
3. Add an optional message
4. The AI will analyze the content

Supported types:
- Text files (.txt, .md, .json, .csv)
- Code files (.ts, .js, .py, etc.)
- Images (for description)

## Real-Time Features

### Streaming Responses

AI responses stream in real-time:
- Text appears word by word
- Better UX than waiting for complete response
- Can cancel mid-stream if needed

### Tool Usage

When the AI uses tools, you see:

```
🔧 Using tool: WebSearch
   Input: "weather in Istanbul"

[Searching...]

✅ Tool result received
```

### Connection Status

The UI shows WebSocket connection status:
- 🟢 Connected
- 🟡 Connecting...
- 🔴 Disconnected (auto-reconnects)

## Authentication

### Token-Based Auth

The Web UI uses token-based authentication:

1. Token generated via `/web` command
2. Passed as URL query parameter
3. Validated on WebSocket connection
4. Expires after 24 hours

### Security

- Tokens are single-use for the session
- No passwords stored in browser
- HTTPS recommended in production
- Automatic session cleanup

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Ctrl+N` | New conversation |
| `Ctrl+K` | Open search |
| `Escape` | Cancel current action |

## Mobile Support

The Web UI is responsive and works on mobile:

- Touch-friendly interface
- Swipe to reveal sidebar
- Optimized for small screens
- Voice input works on mobile browsers

## Customization

### Theme

The UI uses CSS variables for theming. Current theme is dark mode optimized:

```css
--bg-primary: Dark background
--text-primary: Light text
--accent-primary: Blue accent
```

### Settings

Access settings from the menu:
- Change display preferences
- Clear local storage
- View session info

## Technical Details

### Stack

- **React 19**: UI components
- **Tailwind CSS 3**: Styling
- **WebSocket**: Real-time communication
- **Bun.serve**: HTTP/WS server

### WebSocket Protocol

Messages are JSON encoded:

```typescript
// Client → Server
{ type: "chat", payload: { message: "Hello" } }
{ type: "cancel" }
{ type: "ping" }

// Server → Client
{ type: "connected", payload: { sessionId: "..." } }
{ type: "text_delta", payload: { delta: "Hello", fullText: "Hello" } }
{ type: "done", payload: { stats: {...} } }
```

See [WebSocket API](../api/websocket.md) for full protocol documentation.

### Local Storage

The Web UI stores locally:
- Current conversation ID
- UI preferences
- Draft messages

No sensitive data is stored in the browser.

## Troubleshooting

### Can't Connect

1. Check if the token is valid (not expired)
2. Verify Web UI is enabled (`ENABLE_WEB_UI=true`)
3. Check the server is running on the correct port
4. Try generating a new token with `/web`

### Messages Not Sending

1. Check WebSocket connection status
2. Look for errors in browser console
3. Try refreshing the page

### Slow Responses

1. AI responses stream in real-time
2. Complex queries take longer
3. Check network connection

### Token Expired

If you see "Unauthorized" or "Token expired":
1. Return to Telegram
2. Send `/web` again
3. Use the new link

## Deployment Notes

For production deployment:

1. Set `WEB_URL` to your public URL
2. Configure HTTPS (nginx/reverse proxy)
3. Consider rate limiting at proxy level
4. Set appropriate CORS headers if needed

See [Deployment](../deployment.md) for production setup.

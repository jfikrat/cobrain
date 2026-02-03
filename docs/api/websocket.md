# WebSocket API

The WebSocket API provides real-time communication between the Web UI and Cobrain server. It handles chat messages, streaming responses, and conversation management.

## Connection

### Endpoint

```
ws://localhost:3000/ws?token=YOUR_TOKEN
wss://cobrain.example.com/ws?token=YOUR_TOKEN  (production)
```

### Authentication

Include the token as a query parameter:

```javascript
const ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);
```

### Connection Lifecycle

```
Client                              Server
  |                                    |
  |------ WebSocket Connect ---------->|
  |                                    | (validate token)
  |<----- { type: "connected" } -------|
  |                                    |
  |------ { type: "chat" } ----------->|
  |<----- { type: "text_delta" } ------|
  |<----- { type: "text_delta" } ------|
  |<----- { type: "done" } ------------|
  |                                    |
  |------ { type: "ping" } ----------->|
  |<----- { type: "pong" } ------------|
  |                                    |
```

## Message Format

All messages are JSON encoded:

```typescript
{
  type: string
  payload?: any
}
```

## Client → Server Messages

### `chat`

Sends a chat message to the AI.

```typescript
{
  type: "chat",
  payload: {
    message: string
    conversationId?: string  // Optional, for continuing conversation
  }
}
```

**Example**:
```json
{
  "type": "chat",
  "payload": {
    "message": "Hello, how are you?",
    "conversationId": "conv_abc123"
  }
}
```

### `cancel`

Cancels the current streaming response.

```typescript
{
  type: "cancel"
}
```

**Usage**: Send when user wants to stop the AI mid-response.

### `ping`

Keepalive ping.

```typescript
{
  type: "ping"
}
```

**Response**: Server sends `{ type: "pong" }`.

### `sync_conversations`

Requests conversation sync from server.

```typescript
{
  type: "sync_conversations",
  payload: {
    lastSyncAt: number | null  // Unix timestamp of last sync
  }
}
```

**Response**: Server sends `sync_result` with updated conversations.

### `save_message`

Saves a message to a conversation.

```typescript
{
  type: "save_message",
  payload: {
    conversationId: string
    message: {
      id: string
      role: "user" | "assistant"
      content: string
      timestamp: number
      toolUses?: Array<{
        toolName: string
        input: any
        result?: string
      }>
    }
  }
}
```

### `create_conversation`

Creates a new conversation.

```typescript
{
  type: "create_conversation",
  payload: {
    id: string           // Client-generated UUID
    title: string
    createdAt: number    // Unix timestamp
  }
}
```

### `delete_conversation`

Soft-deletes a conversation.

```typescript
{
  type: "delete_conversation",
  payload: {
    id: string
  }
}
```

### `update_conversation_title`

Updates a conversation's title.

```typescript
{
  type: "update_conversation_title",
  payload: {
    id: string
    title: string
  }
}
```

## Server → Client Messages

### `connected`

Sent on successful connection.

```typescript
{
  type: "connected",
  payload: {
    sessionId: string | null
    userId: number
  }
}
```

### `text_delta`

Streaming text chunk from AI response.

```typescript
{
  type: "text_delta",
  payload: {
    delta: string      // New text chunk
    fullText: string   // Complete text so far
  }
}
```

**Usage**: Append `delta` to display, or replace with `fullText`.

### `tool_use`

AI is invoking a tool.

```typescript
{
  type: "tool_use",
  payload: {
    toolName: string
    input: any
  }
}
```

**Example**:
```json
{
  "type": "tool_use",
  "payload": {
    "toolName": "WebSearch",
    "input": { "query": "weather in Istanbul" }
  }
}
```

### `tool_result`

Tool execution completed.

```typescript
{
  type: "tool_result",
  payload: {
    toolName: string
    result: string
  }
}
```

### `done`

AI response completed.

```typescript
{
  type: "done",
  payload: {
    stats: {
      inputTokens: number
      outputTokens: number
      totalCost: number
    }
    conversationId?: string
    messageId?: string
  }
}
```

### `error`

Error occurred.

```typescript
{
  type: "error",
  payload: {
    message: string
    code?: string
  }
}
```

**Error codes**:
- `UNAUTHORIZED`: Invalid token
- `RATE_LIMITED`: Too many requests
- `INTERNAL_ERROR`: Server error
- `CANCELLED`: Request was cancelled

### `pong`

Response to ping.

```typescript
{
  type: "pong"
}
```

### `sync_result`

Conversation sync response.

```typescript
{
  type: "sync_result",
  payload: {
    conversations: Array<{
      id: string
      title: string
      createdAt: number
      updatedAt: number
      messages?: Message[]
    }>
    syncedAt: number
  }
}
```

## Example: Complete Chat Flow

```javascript
const ws = new WebSocket('ws://localhost:3000/ws?token=xxx');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'connected':
      console.log('Session:', msg.payload.sessionId);
      // Send a message
      ws.send(JSON.stringify({
        type: 'chat',
        payload: { message: 'Hello!' }
      }));
      break;

    case 'text_delta':
      // Update UI with streaming text
      document.getElementById('response').textContent = msg.payload.fullText;
      break;

    case 'tool_use':
      console.log(`Using tool: ${msg.payload.toolName}`);
      break;

    case 'done':
      console.log('Response complete');
      console.log('Tokens:', msg.payload.stats.inputTokens + msg.payload.stats.outputTokens);
      break;

    case 'error':
      console.error('Error:', msg.payload.message);
      break;
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected');
};
```

## Example: Conversation Management

```javascript
// Create new conversation
ws.send(JSON.stringify({
  type: 'create_conversation',
  payload: {
    id: crypto.randomUUID(),
    title: 'New Chat',
    createdAt: Date.now()
  }
}));

// Sync conversations
ws.send(JSON.stringify({
  type: 'sync_conversations',
  payload: { lastSyncAt: null }  // Full sync
}));

// Save message
ws.send(JSON.stringify({
  type: 'save_message',
  payload: {
    conversationId: 'conv_abc123',
    message: {
      id: crypto.randomUUID(),
      role: 'user',
      content: 'Hello!',
      timestamp: Date.now()
    }
  }
}));
```

## Reconnection

The client should implement reconnection logic:

```javascript
class WebSocketClient {
  constructor(url) {
    this.url = url;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000; // Reset on success
    };

    this.ws.onclose = () => {
      setTimeout(() => {
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.maxReconnectDelay
        );
        this.connect();
      }, this.reconnectDelay);
    };
  }
}
```

## Keepalive

Send periodic pings to keep the connection alive:

```javascript
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 30000); // Every 30 seconds
```

## Binary Messages

Binary messages are not supported. All communication is JSON text.

## Message Size Limits

- Maximum message size: 64 KB
- Larger messages will be rejected

## Concurrent Connections

- One active connection per token
- New connection closes previous one
- Token can be reused within 24-hour validity

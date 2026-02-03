# HTTP API

Cobrain exposes a minimal HTTP API primarily for the Web UI. The server runs on `WEB_PORT` (default: 3000) when `ENABLE_WEB_UI=true`.

## Base URL

```
http://localhost:3000
```

In production, configure `WEB_URL` to your public URL.

## Endpoints

### GET /

Serves the Web UI.

**Response**: HTML page (React application)

**Usage**:
```bash
curl http://localhost:3000
```

Returns the main index.html which loads the React frontend.

### GET /health

Health check endpoint.

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-01-25T10:00:00.000Z"
}
```

**Usage**:
```bash
curl http://localhost:3000/health
```

### GET /api/status

Returns server status and version information.

**Response**:
```json
{
  "status": "running",
  "version": "0.4.0",
  "timestamp": "2024-01-25T10:00:00.000Z",
  "uptime": 3600
}
```

**Fields**:
- `status`: Server state ("running")
- `version`: Cobrain version
- `timestamp`: Current server time (ISO 8601)
- `uptime`: Server uptime in seconds

**Usage**:
```bash
curl http://localhost:3000/api/status
```

### WebSocket /ws

Upgrades to WebSocket connection for real-time chat.

**Query Parameters**:
- `token` (required): Authentication token from `/web` command

**Example**:
```javascript
const ws = new WebSocket('ws://localhost:3000/ws?token=YOUR_TOKEN');
```

See [WebSocket API](./websocket.md) for message protocol.

## Authentication

### Token-Based Auth

The Web UI uses token-based authentication:

1. User requests token via Telegram `/web` command
2. Token is generated with 24-hour expiry
3. Token passed as URL query parameter
4. Validated on WebSocket connection

### Token Format

Tokens are opaque strings generated server-side:
```
eyJhbGciOiJIUzI1NiIs...
```

### Token Validation

The server validates:
- Token exists in database
- Token hasn't expired
- Token maps to valid user

## Static Files

Static assets are served from `/public`:

```
GET /app.js           → Bundled React app
GET /styles/output.css → Compiled Tailwind CSS
GET /favicon.ico      → Site icon
```

These are served automatically by Bun.serve's static file handling.

## Error Responses

### 401 Unauthorized

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired token"
}
```

### 404 Not Found

```json
{
  "error": "Not Found",
  "message": "Endpoint does not exist"
}
```

### 500 Internal Server Error

```json
{
  "error": "Internal Server Error",
  "message": "An unexpected error occurred"
}
```

## CORS

By default, CORS is not configured (same-origin only).

For cross-origin access, configure your reverse proxy or add CORS headers:

```typescript
// In production, handled by nginx/reverse proxy
Access-Control-Allow-Origin: https://your-domain.com
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

## Rate Limiting

No built-in rate limiting. For production:

1. Use a reverse proxy (nginx)
2. Configure rate limits at proxy level
3. Consider per-token limits

Example nginx config:
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;

location /api/ {
    limit_req zone=api burst=20;
    proxy_pass http://localhost:3000;
}
```

## Server Implementation

The HTTP server uses Bun.serve:

```typescript
Bun.serve({
  port: config.WEB_PORT,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date() });
    }

    if (url.pathname === '/api/status') {
      return Response.json({
        status: 'running',
        version: '0.4.0',
        timestamp: new Date(),
        uptime: process.uptime()
      });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      // ... validation and upgrade
    }

    // Static files and index.html
    return serveStatic(request);
  },
  websocket: {
    // ... WebSocket handlers
  }
});
```

## Production Deployment

### Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name cobrain.example.com;

    ssl_certificate /etc/ssl/certs/cobrain.crt;
    ssl_certificate_key /etc/ssl/private/cobrain.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Environment Variables

```env
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=https://cobrain.example.com
```

The `WEB_URL` is used to generate links in Telegram messages.

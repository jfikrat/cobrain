# HTTP API

Cobrain exposes a small Bun HTTP API for external agents, automations, and health checks. The server listens on `API_PORT` and does not serve a frontend.

## Base URL

```text
http://localhost:3000
```

Set `API_PORT` to move the server to a different port.

## Authentication

- `GET /health` is public.
- Every `/api/*` route requires `Authorization: Bearer <COBRAIN_API_KEY>`.
- If `COBRAIN_API_KEY` is empty, authenticated API routes will return `401 Unauthorized`.

Example:

```bash
curl \
  -H "Authorization: Bearer $COBRAIN_API_KEY" \
  http://localhost:3000/api/memory/recall
```

## Endpoints

### GET /health

Simple liveness probe.

Response:

```text
OK
```

Example:

```bash
curl http://localhost:3000/health
```

### POST /api/chat

Send a message into Cobrain and get the model response as JSON.

Request body:

```json
{
  "message": "Summarize today's priorities",
  "model": "claude-sonnet-4-6",
  "sessionKey": "daily-checkin",
  "silent": false,
  "systemPromptOverride": "Be terse."
}
```

Fields:

- `message` is required.
- `model` is optional.
- `sessionKey` is optional and is forwarded into chat session handling.
- `silent` skips Telegram mirroring when `true`.
- `systemPromptOverride` is optional and replaces the normal system prompt.

Example:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Authorization: Bearer $COBRAIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Summarize priorities","sessionKey":"daily-checkin"}'
```

Validation error:

```json
{ "error": "message required" }
```

### POST /api/report

Push a report from an external agent into Cobrain's inbox.

Request body:

```json
{
  "agentId": "research",
  "subject": "Daily digest ready",
  "message": "Three follow-ups need attention.",
  "priority": "normal"
}
```

Fields:

- `agentId`, `subject`, and `message` are required.
- `priority` may be `urgent` or `normal`.
- Reports with `agentId === "wa"` are accepted but logged only; they are not queued into the inbox.

Success response:

```json
{ "ok": true, "queued": true }
```

Validation error:

```json
{ "error": "agentId, subject, message required" }
```

### GET /api/memory/recall

Read a snapshot of Cobrain memory for the configured Telegram user.

Query parameters:

- `query` optional, defaults to `all`
- `days` optional, defaults to `30`

Example:

```bash
curl "http://localhost:3000/api/memory/recall?query=projects&days=14" \
  -H "Authorization: Bearer $COBRAIN_API_KEY"
```

Response shape:

```json
{
  "facts": "...",
  "events": "...",
  "query": "projects"
}
```

### POST /api/memory/remember

Write semantic or episodic memory on behalf of an external agent.

Request body:

```json
{
  "content": "Cagla prefers updates before noon.",
  "type": "semantic",
  "section": "People"
}
```

Fields:

- `content` is required.
- `type` may be `semantic` or `episodic`.
- `section` is optional and only used for semantic memories.

Success response:

```json
{ "ok": true }
```

Validation error:

```json
{ "error": "content required" }
```

## Common Error Responses

Unauthorized:

```json
{ "error": "Unauthorized" }
```

Unexpected server error:

```json
{ "error": "Unknown error" }
```

Unknown route:

```text
Not Found
```

## Notes

- The API runs from `src/api-server.ts`.
- `POST /api/chat` and `POST /api/report` are designed for trusted local or reverse-proxied callers.
- For public exposure, add TLS, rate limiting, and IP filtering at the reverse proxy layer.

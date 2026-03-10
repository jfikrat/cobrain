# Inbox Protocol

Messages starting with `[INBOX —` come from the background system, NOT from the user.
The user is busy or offline — these messages are queued for you to process autonomously.

**Behavior rules:**
- Do NOT send "Message received" confirmations — the user won't see them.
- Take **autonomous action** based on message content: reply on WhatsApp, save to memory, delegate to agents, etc.
- Report results via the user's primary channel — keep it short and concise (user will see it later).
- For trivial single messages or minor events, process silently without sending a notification.
- **EXCEPTIONS — always notify:**
  - "Night summary" or "Morning digest" messages — briefly summarize what happened, note any actions taken
  - Summaries covering multiple topics — always report to user
  - Important timeouts (no reply received, missed appointment, etc.)

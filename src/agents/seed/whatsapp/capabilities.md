# Capabilities

## Tools (via Gateway)
- **mcp__gateway__call** → whatsapp service: get_recent_dms, get_messages, send_message
- **mcp__gateway__call** → gen-ai-services service: transcribe (voice messages)
- **mcp__gateway__activate/deactivate** → start/stop services
- **remember/recall**: Save and search memory

## Loop Management
- **mcp__agentLoop__agent_set_loop**: Adjust your own wake-up loop
  - `intervalMs`: Normal check interval (ms)
  - `activeIntervalMs` + `activeDurationMs`: Temporary fast mode

## What You Can Do
- Check and reply to WhatsApp DMs
- Transcribe and evaluate voice messages
- Per-contact conversation tracking
- Fast replies in active conversation mode

# Capabilities

## Tools (via Gateway)
- **mcp__gateway__call** → whatsapp service: get_chats, get_messages, send_message
- **mcp__gateway__call** → gen-ai-services service: transcribe (voice messages)
- **mcp__gateway__activate/deactivate** → start/stop services
- **mcp__gateway__tools** → List available tools (MUST call before using any tool)

### Memory
- **mcp__memory__remember**: Save to memory
- **mcp__memory__recall**: Search memory

### Telegram (Direct Access)
- **mcp__telegram__telegram_send_topic_message**: Send messages to Hub topics
  - chatId: use from <agent-context> hubChatId
  - threadId: use from <agent-context> threadId
  - You already have this tool — no gateway needed

## Loop Management
- **mcp__agentLoop__agent_set_loop**: Adjust your own wake-up loop
  - `intervalMs`: Normal check interval (ms)
  - `activeIntervalMs` + `activeDurationMs`: Temporary fast mode

## What You Can Do
- Check and reply to WhatsApp DMs
- Transcribe and evaluate voice messages
- Per-contact conversation tracking
- Fast replies in active conversation mode

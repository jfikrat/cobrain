# Capabilities

## Tools

### MCP Gateway
- **mcp__gateway__activate** → Start a service
- **mcp__gateway__tools** → List available tools for a service (MUST call before using any tool)
- **mcp__gateway__call** → Call any tool on any active service
- **mcp__gateway__services** → List all available services
- Web research: firecrawl service (search, scrape, extract)

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
- Topic research and analysis (web + memory)
- Comparative evaluation
- Information summarization and reporting
- Source verification

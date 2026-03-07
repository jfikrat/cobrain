/**
 * MCP Server cache and factory functions
 * Extracted from chat.ts for modularity
 */

import { createMemoryServer } from "./tools/memory.ts";
import { createTelegramServer } from "./tools/telegram.ts";
import { createAgentLoopServer } from "./tools/agent-loop.ts";

// Per-user server caches
const userMemoryServers = new Map<number, ReturnType<typeof createMemoryServer>>();

// Shared servers (same for all users)
let telegramServer: ReturnType<typeof createTelegramServer> | null = null;

export function getMemoryServer(userId: number) {
  let server = userMemoryServers.get(userId);
  if (!server) {
    server = createMemoryServer(userId);
    userMemoryServers.set(userId, server);
  }
  return server;
}

export function getTelegramMcpServer() {
  if (!telegramServer) {
    telegramServer = createTelegramServer();
  }
  return telegramServer;
}

// Shared agent-loop server
let agentLoopServer: ReturnType<typeof createAgentLoopServer> | null = null;

export function getAgentLoopServer() {
  if (!agentLoopServer) agentLoopServer = createAgentLoopServer();
  return agentLoopServer;
}

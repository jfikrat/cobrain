/**
 * MCP Server cache and factory functions
 * Extracted from chat.ts for modularity
 */

import { createMemoryServer } from "./tools/memory.ts";
import { createTelegramServer } from "./tools/telegram.ts";
import { getTimeServer } from "./tools/time.ts";
import { createMoodServer } from "./tools/mood.ts";
import { createCalendarServer } from "./tools/calendar.ts";
import { createGmailServer } from "./tools/gmail.ts";
import { createGDriveServer } from "./tools/gdrive.ts";
import { createAgentLoopServer } from "./tools/agent-loop.ts";

// Per-user server caches
const userMemoryServers = new Map<number, ReturnType<typeof createMemoryServer>>();
const userMoodServers = new Map<number, ReturnType<typeof createMoodServer>>();
const userGmailServers = new Map<number, ReturnType<typeof createGmailServer>>();

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


export function getMoodServer(userId: number) {
  let server = userMoodServers.get(userId);
  if (!server) {
    server = createMoodServer(userId);
    userMoodServers.set(userId, server);
  }
  return server;
}


// Shared calendar server
let calendarServer: ReturnType<typeof createCalendarServer> | null = null;

export function getCalendarServer() {
  if (!calendarServer) {
    calendarServer = createCalendarServer();
  }
  return calendarServer;
}

export function getGmailServer(userId: number) {
  let server = userGmailServers.get(userId);
  if (!server) {
    server = createGmailServer(userId);
    userGmailServers.set(userId, server);
  }
  return server;
}

// Shared GDrive server
let gdriveServer: ReturnType<typeof createGDriveServer> | null = null;

export function getGDriveServer() {
  if (!gdriveServer) {
    gdriveServer = createGDriveServer();
  }
  return gdriveServer;
}

// Shared agent-loop server
let agentLoopServer: ReturnType<typeof createAgentLoopServer> | null = null;

export function getAgentLoopServer() {
  if (!agentLoopServer) agentLoopServer = createAgentLoopServer();
  return agentLoopServer;
}

// Re-export getTimeServer for convenience
export { getTimeServer };

/**
 * MCP Server cache and factory functions
 * Extracted from chat.ts for modularity
 */

import { createMemoryServer } from "./tools/memory.ts";
import { createGoalsServer } from "./tools/goals.ts";
import { createPersonaServer } from "./tools/persona.ts";
import { createTelegramServer } from "./tools/telegram.ts";
import { getTimeServer } from "./tools/time.ts";
import { createMoodServer } from "./tools/mood.ts";
import { createLocationServer } from "./tools/location.ts";
import { createCalendarServer } from "./tools/calendar.ts";
import { createGmailServer } from "./tools/gmail.ts";

// Per-user server caches
const userMemoryServers = new Map<number, ReturnType<typeof createMemoryServer>>();
const userGoalsServers = new Map<number, ReturnType<typeof createGoalsServer>>();
const userPersonaServers = new Map<number, ReturnType<typeof createPersonaServer>>();
const userMoodServers = new Map<number, ReturnType<typeof createMoodServer>>();
const userLocationServers = new Map<number, ReturnType<typeof createLocationServer>>();
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

export function getGoalsServer(userId: number) {
  let server = userGoalsServers.get(userId);
  if (!server) {
    server = createGoalsServer(userId);
    userGoalsServers.set(userId, server);
  }
  return server;
}

export function getPersonaServer(userId: number) {
  let server = userPersonaServers.get(userId);
  if (!server) {
    server = createPersonaServer(userId);
    userPersonaServers.set(userId, server);
  }
  return server;
}

export function getMoodServer(userId: number) {
  let server = userMoodServers.get(userId);
  if (!server) {
    server = createMoodServer(userId);
    userMoodServers.set(userId, server);
  }
  return server;
}

export function getLocationServer(userId: number) {
  let server = userLocationServers.get(userId);
  if (!server) {
    server = createLocationServer(userId);
    userLocationServers.set(userId, server);
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

// Re-export getTimeServer for convenience
export { getTimeServer };

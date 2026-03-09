/**
 * Agent Registry
 * CRUD for agents.json — in-memory cache + atomic file writes
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { invalidateHubContextCache } from "./hub-context.ts";

export type AgentType = "general" | "whatsapp" | "code" | "research" | "custom";

export interface AgentEntry {
  id: string;
  name: string;
  type: AgentType;
  topicId: number;
  mindDir: string;
  sharedMindFiles: string[];
  sessionKeyPrefix: string;
  status: "active" | "archived";
  createdAt: string;
  lastActiveAt?: string;
  description?: string;
  workDir?: string;
}

export interface AgentRegistry {
  hubChatId: number;
  agents: AgentEntry[];
}

// In-memory cache
let _registry: AgentRegistry | null = null;
let _userFolder: string | null = null;

function registryPath(userFolder: string): string {
  return join(userFolder, "agents.json");
}

export async function loadRegistry(userFolder: string): Promise<AgentRegistry> {
  _userFolder = userFolder;
  const path = registryPath(userFolder);

  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      _registry = (await file.json()) as AgentRegistry;
      // Repair missing mind files for active agents (non-blocking)
      repairAgentMindFiles(userFolder, _registry.agents).catch(() => {});
      return _registry;
    }
  } catch (err) {
    console.warn("[Registry] Failed to load agents.json, starting fresh:", err);
  }

  // Default empty registry
  _registry = { hubChatId: 0, agents: [] };
  return _registry;
}

/** Repair missing mind files for all active agents (idempotent) */
async function repairAgentMindFiles(userFolder: string, agents: AgentEntry[]): Promise<void> {
  try {
    const { repairAllAgentMindFiles } = await import("./seed/index.ts");
    await repairAllAgentMindFiles(userFolder, agents);
  } catch (err) {
    console.warn("[Registry] Agent mind file repair failed:", err);
  }
}

export async function saveRegistry(userFolder: string, reg: AgentRegistry): Promise<void> {
  const path = registryPath(userFolder);
  const tmpPath = join(tmpdir(), `agents-${Date.now()}.json`);

  // Atomic write: tmp file → rename
  await Bun.write(tmpPath, JSON.stringify(reg, null, 2));

  const { rename, mkdir } = await import("node:fs/promises");
  await mkdir(join(userFolder), { recursive: true });

  // rename across filesystems may fail, fallback to write directly
  try {
    await rename(tmpPath, path);
  } catch {
    await Bun.write(path, JSON.stringify(reg, null, 2));
    try { await import("node:fs/promises").then(fs => fs.unlink(tmpPath)); } catch {}
  }

  _registry = reg;
}

function getRegistry(): AgentRegistry {
  if (!_registry) throw new Error("Agent registry not loaded. Call loadRegistry() first.");
  return _registry;
}

function getUserFolder(): string {
  if (!_userFolder) throw new Error("Agent registry not loaded. Call loadRegistry() first.");
  return _userFolder;
}

export function getAgentByTopicId(topicId: number): AgentEntry | null {
  const reg = getRegistry();
  return reg.agents.find(a => a.topicId === topicId && a.status === "active") ?? null;
}

export function getAgentById(id: string): AgentEntry | null {
  const reg = getRegistry();
  return reg.agents.find(a => a.id === id) ?? null;
}

export async function registerAgent(
  entry: Omit<AgentEntry, "createdAt">,
): Promise<AgentEntry> {
  const reg = getRegistry();
  const folder = getUserFolder();

  // Check for duplicate id
  if (reg.agents.some(a => a.id === entry.id)) {
    throw new Error(`Agent "${entry.id}" already exists`);
  }

  const agent: AgentEntry = {
    ...entry,
    createdAt: new Date().toISOString(),
  };

  reg.agents.push(agent);
  await saveRegistry(folder, reg);

  console.log(`[Registry] Agent registered: ${agent.id} (topic: ${agent.topicId})`);
  return agent;
}

export async function archiveAgent(id: string): Promise<void> {
  const reg = getRegistry();
  const folder = getUserFolder();
  const agent = reg.agents.find(a => a.id === id);
  if (!agent) throw new Error(`Agent "${id}" not found`);

  agent.status = "archived";
  await saveRegistry(folder, reg);

  console.log(`[Registry] Agent archived: ${id}`);
}

export function updateAgentActivity(id: string): void {
  const agent = getRegistry().agents.find(a => a.id === id);
  if (agent) {
    agent.lastActiveAt = new Date().toISOString();
  }
  // Lazy save — don't await, fire-and-forget
  if (_userFolder && _registry) {
    saveRegistry(_userFolder, _registry).catch(() => {});
  }
  // Invalidate hub context cache so next chat turn sees fresh data
  invalidateHubContextCache();
}

export function listActiveAgents(): AgentEntry[] {
  return getRegistry().agents.filter(a => a.status === "active");
}

export function setHubChatId(chatId: number): void {
  const reg = getRegistry();
  reg.hubChatId = chatId;
  if (_userFolder) {
    saveRegistry(_userFolder, reg).catch(() => {});
  }
}

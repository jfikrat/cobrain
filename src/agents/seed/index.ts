/**
 * Agent Seed Scaffolding
 * Copies seed mind files to user's agent directory on creation.
 * Idempotent — never overwrites existing files.
 */

import { join, resolve } from "node:path";
import { mkdir, copyFile, readdir } from "node:fs/promises";
import type { AgentType, AgentEntry } from "../registry.ts";

const SEED_DIR = resolve(import.meta.dir);

// Types that have seed directories
const SEED_TYPES: AgentType[] = ["general", "code", "research", "whatsapp"];

/**
 * Scaffold mind files for an agent.
 * Copies MISSING seed files from src/agents/seed/{type}/ to {userFolder}/agents/{agentId}/mind/
 * Never overwrites existing files. Safe to call multiple times (idempotent).
 * Returns the relative mindDir path (e.g. "agents/code/mind")
 */
export async function scaffoldAgentMindFiles(
  userFolder: string,
  agentId: string,
  agentType: AgentType,
  customName?: string,
): Promise<string> {
  const relMindDir = `agents/${agentId}/mind`;
  const targetDir = join(userFolder, relMindDir);

  await mkdir(targetDir, { recursive: true });

  // Determine seed source - custom types fall back to "general"
  const seedType = SEED_TYPES.includes(agentType) ? agentType : "general";
  const sourceDir = join(SEED_DIR, seedType);

  let identityIsNew = false;

  try {
    const files = await readdir(sourceDir);
    for (const file of files) {
      if (!file.endsWith(".md") && !file.endsWith(".json")) continue;
      const target = join(targetDir, file);
      if (await Bun.file(target).exists()) continue; // idempotent: skip existing
      await copyFile(join(sourceDir, file), target);
      if (file === "identity.md") identityIsNew = true;
    }
  } catch (err) {
    console.warn(`[Seed] Failed to copy seed files for ${agentType}:`, err);
    // Write a minimal identity.md fallback only if it doesn't exist
    const identityPath = join(targetDir, "identity.md");
    if (!(await Bun.file(identityPath).exists())) {
      const displayName = customName || agentId;
      const fallback = `# Identity\n\nYou are Cobrain's "${displayName}" agent.\nReply briefly and naturally.\n`;
      await Bun.write(identityPath, fallback);
      identityIsNew = true;
    }
  }

  // Only patch custom name when identity.md was just created from seed
  if (customName && identityIsNew && agentType !== "custom") {
    const identityPath = join(targetDir, "identity.md");
    try {
      let content = await Bun.file(identityPath).text();
      content += `\nYour agent name: ${customName}\n`;
      await Bun.write(identityPath, content);
    } catch (e) {
      console.warn("[Seed] Identity customize failed:", e);
    }
  }

  return relMindDir;
}

/**
 * Repair missing mind files for all active agents.
 * Called at startup to ensure existing agents get new seed files added later.
 */
export async function repairAllAgentMindFiles(
  userFolder: string,
  agents: AgentEntry[],
): Promise<void> {
  for (const agent of agents) {
    if (agent.status !== "active") continue;
    await scaffoldAgentMindFiles(userFolder, agent.id, agent.type);
  }
}

/**
 * Agent Seed Scaffolding
 * Copies seed mind files to user's agent directory on creation
 */

import { join, resolve } from "node:path";
import { mkdir, copyFile, readdir } from "node:fs/promises";
import type { AgentType } from "../registry.ts";

const SEED_DIR = resolve(import.meta.dir);

// Types that have seed directories
const SEED_TYPES: AgentType[] = ["genel", "kod", "arastirma", "whatsapp"];

/**
 * Scaffold mind files for a new agent.
 * Copies seed files from src/agents/seed/{type}/ to {userFolder}/agents/{agentId}/mind/
 * Returns the relative mindDir path (e.g. "agents/kod/mind")
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

  // Determine seed source — custom types fall back to "genel"
  const seedType = SEED_TYPES.includes(agentType) ? agentType : "genel";
  const sourceDir = join(SEED_DIR, seedType);

  try {
    const files = await readdir(sourceDir);
    for (const file of files) {
      if (!file.endsWith(".md") && !file.endsWith(".json")) continue;
      await copyFile(join(sourceDir, file), join(targetDir, file));
    }
  } catch (err) {
    console.warn(`[Seed] Failed to copy seed files for ${agentType}:`, err);
    // Write a minimal identity.md fallback
    const displayName = customName || agentId;
    const fallback = `# Kimlik\n\nSen Cobrain'in "${displayName}" agent'ısın.\nTürkçe, kısa ve doğal cevaplar ver.\n`;
    await Bun.write(join(targetDir, "identity.md"), fallback);
  }

  // If custom name differs from seed, patch identity.md
  if (customName && agentType !== "custom") {
    const identityPath = join(targetDir, "identity.md");
    try {
      let content = await Bun.file(identityPath).text();
      // Append custom name context
      content += `\nAgent adın: ${customName}\n`;
      await Bun.write(identityPath, content);
    } catch (e) {
      console.warn("[Seed] Identity customize failed:", e);
    }
  }

  console.log(`[Seed] Scaffolded ${agentType} mind files → ${relMindDir}`);
  return relMindDir;
}

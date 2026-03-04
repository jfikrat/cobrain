/**
 * Agent Template Scaffolding
 * Copies template mind files to user's agent directory
 */

import { join, resolve } from "node:path";
import { mkdir, copyFile, readdir } from "node:fs/promises";
import type { AgentType } from "../registry.ts";

const TEMPLATES_DIR = resolve(import.meta.dir);

// Types that have template directories
const TEMPLATE_TYPES: AgentType[] = ["genel", "kod", "arastirma", "whatsapp"];

/**
 * Scaffold mind files for a new agent.
 * Copies templates from src/agents/templates/{type}/ to {userFolder}/agents/{agentId}/mind/
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

  // Determine template source — custom types fall back to "genel"
  const templateType = TEMPLATE_TYPES.includes(agentType) ? agentType : "genel";
  const sourceDir = join(TEMPLATES_DIR, templateType);

  try {
    const files = await readdir(sourceDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      await copyFile(join(sourceDir, file), join(targetDir, file));
    }
  } catch (err) {
    console.warn(`[Templates] Failed to copy templates for ${agentType}:`, err);
    // Write a minimal identity.md fallback
    const displayName = customName || agentId;
    const fallback = `# Kimlik\n\nSen Cobrain'in "${displayName}" agent'ısın.\nTürkçe, kısa ve doğal cevaplar ver.\n`;
    await Bun.write(join(targetDir, "identity.md"), fallback);
  }

  // If custom name differs from template, patch identity.md
  if (customName && agentType !== "custom") {
    const identityPath = join(targetDir, "identity.md");
    try {
      let content = await Bun.file(identityPath).text();
      // Append custom name context
      content += `\nAgent adın: ${customName}\n`;
      await Bun.write(identityPath, content);
    } catch {}
  }

  console.log(`[Templates] Scaffolded ${agentType} mind files → ${relMindDir}`);
  return relMindDir;
}

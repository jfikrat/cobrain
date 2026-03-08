/**
 * Memory Tools for Cobrain Agent
 * File-based backend: facts.md (permanent) + events.md (dated log)
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FileMemory } from "../../memory/file-memory.ts";
import { userManager } from "../../services/user-manager.ts";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";

// Per-user FileMemory instances
const memoryCache = new Map<number, FileMemory>();

function getMemory(userId: number): FileMemory {
  if (!memoryCache.has(userId)) {
    const userFolder = userManager.getUserFolder(userId);
    memoryCache.set(userId, new FileMemory(userFolder));
  }
  return memoryCache.get(userId)!;
}

// ── Tool Factories (FileMemory-based) ────────────────────────────────────

function createRememberToolFrom(memory: FileMemory) {
  return tool(
    "remember",
    "Save important information to long-term memory. Use for personal information, preferences, and facts.",
    {
      content: z.string().describe("Information to remember"),
      type: z
        .enum(["semantic", "episodic", "procedural"])
        .default("semantic")
        .describe("semantic=fact/preference (facts.md), episodic=event (events.md), procedural=how-to (facts.md)"),
      section: z
        .string()
        .optional()
        .describe("Section heading for facts.md (e.g. 'Location', 'Career', 'Preferences'). Not used for episodic."),
    },
    async ({ content, type, section }) => {
      try {
        if (type === "episodic") {
          await memory.logEvent(content);
          console.log(`[Memory] Event logged: ${content.slice(0, 60)}...`);
          return toolSuccess(`Event saved: ${content.slice(0, 60)}`);
        } else {
          const sectionName = section || inferSection(content, type);
          await memory.storeFact(sectionName, content);
          console.log(`[Memory] Fact stored [${sectionName}]: ${content.slice(0, 60)}...`);
          return toolSuccess(`Saved to memory [${sectionName}]: ${content.slice(0, 60)}`);
        }
      } catch (error) {
        return toolError("Memory error", error);
      }
    }
  );
}

function createRecallToolFrom(memory: FileMemory) {
  return tool(
    "recall",
    "Search memory. Returns previously saved facts and events.",
    {
      query: z.string().describe("Search query, or 'all' to read all memory"),
      days: z.number().default(30).describe("How many days of event history (events only)"),
    },
    async ({ query, days }) => {
      try {
        if (query === "all") {
          const all = await memory.readAll(days);
          if (!all) return toolSuccess("Memory is empty.");
          return toolSuccess(all);
        }

        // Search in both files
        const facts = await memory.readFacts();
        const events = await memory.readRecentEvents(days);
        const q = query.toLowerCase();

        const matchingFacts = facts
          .split("\n")
          .filter(l => l.toLowerCase().includes(q));
        const matchingEvents = events
          .split("\n")
          .filter(l => l.toLowerCase().includes(q));

        const results: string[] = [];
        if (matchingFacts.length > 0) results.push(`**Facts:**\n${matchingFacts.join("\n")}`);
        if (matchingEvents.length > 0) results.push(`**Events:**\n${matchingEvents.join("\n")}`);

        if (results.length === 0) return toolSuccess("No relevant memory found.");
        return toolSuccess(results.join("\n\n"));
      } catch (error) {
        return toolError("Search error", error);
      }
    }
  );
}

function createStatsToolFrom(memory: FileMemory) {
  return tool("memory_stats", "Show memory file contents and size.", {}, async () => {
    try {
      const facts = await memory.readFacts();
      const events = await memory.readRecentEvents(90);

      const factLines = facts.split("\n").filter(l => l.trim()).length;
      const eventLines = events.split("\n").filter(l => l.startsWith("- ")).length;

      return toolSuccess(`Memory Status:
- facts.md: ${factLines} lines
- events.md (90 days): ${eventLines} event entries`);
    } catch (error) {
      return toolError("Stats error", error);
    }
  });
}

// ── Server Builders ─────────────────────────────────────────────────────

function _buildServer(memory: FileMemory) {
  return createSdkMcpServer({
    name: "cobrain-memory",
    version: "2.0.0",
    tools: [createRememberToolFrom(memory), createRecallToolFrom(memory), createStatsToolFrom(memory)],
  });
}

// ── Public API ──────────────────────────────────────────────────────────

/** Existing API — userId-based (Cobrain main agent) */
export function createMemoryServer(userId: number) {
  const memory = getMemory(userId);
  return _buildServer(memory);
}

/** New API — path-based (WA Agent, standalone agents) */
export function createMemoryServerFromPath(userFolder: string) {
  const memory = new FileMemory(userFolder);
  return _buildServer(memory);
}

// Legacy exports for backwards compatibility (used by mcp-servers.ts cache)
export const rememberTool = (userId: number) => createRememberToolFrom(getMemory(userId));
export const recallTool = (userId: number) => createRecallToolFrom(getMemory(userId));
export const memoryStatsTool = (userId: number) => createStatsToolFrom(getMemory(userId));

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferSection(content: string, type: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("yaşıyor") || lower.includes("otur") || lower.includes("istanbul") || lower.includes("ankara") || lower.includes("şehir")) return "Location";
  if (lower.includes("meslek") || lower.includes("çalış") || lower.includes("iş") || lower.includes("mühendis") || lower.includes("yazılım")) return "Career";
  if (lower.includes("eş") || lower.includes("karı") || lower.includes("koca") || lower.includes("evli")) return "Family";
  if (lower.includes("anne") || lower.includes("baba") || lower.includes("kardeş") || lower.includes("çocuk")) return "Family";
  if (lower.includes("sever") || lower.includes("tercih") || lower.includes("hoşlan") || lower.includes("sevmez")) return "Preferences";
  if (lower.includes("hedef") || lower.includes("plan") || lower.includes("yapmak istiyor")) return "Goals";
  if (type === "procedural") return "How-To";
  return "Notes";
}

/**
 * Memory Tools for Cobrain Agent
 * MCP tools for long-term memory management
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SmartMemory } from "../../memory/smart-memory.ts";
import { userManager } from "../../services/user-manager.ts";
import { createCloseableUserCache } from "../../utils/user-cache.ts";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";

// User-based SmartMemory cache with close support
const memoryCache = createCloseableUserCache((userId: number) => {
  const userFolder = userManager.getUserFolder(userId);
  return new SmartMemory(userFolder, userId);
});

export const rememberTool = (userId: number) =>
  tool(
    "remember",
    "Önemli bir bilgiyi uzun vadeli hafızaya kaydet. Kişisel bilgiler, tercihler, öğrenilen gerçekler için kullan.",
    {
      content: z.string().describe("Hatırlanacak bilgi"),
      type: z
        .enum(["semantic", "episodic", "procedural"])
        .default("semantic")
        .describe("Hafıza tipi: semantic (gerçekler), episodic (olaylar), procedural (nasıl yapılır)"),
      importance: z.number().min(0).max(1).default(0.5).describe("Önem derecesi (0-1)"),
    },
    async ({ content, type, importance }) => {
      try {
        const memory = await memoryCache.get(userId);
        const id = await memory.store({ content, type, importance, source: "agent" });

        console.log(`[Memory] Stored #${id} for user ${userId}: ${content.slice(0, 50)}...`);
        return toolSuccess(`Hafızaya kaydedildi (ID: ${id}, tip: ${type})`);
      } catch (error) {
        return toolError("Hafıza hatası", error);
      }
    }
  );

export const recallTool = (userId: number) =>
  tool(
    "recall",
    "Hafızada ara. Daha önce kaydedilen bilgileri bul.",
    {
      query: z.string().describe("Arama sorgusu"),
      limit: z.number().default(5).describe("Maksimum sonuç sayısı"),
      type: z
        .enum(["semantic", "episodic", "procedural"])
        .optional()
        .describe("Sadece belirli tipte hafızaları ara"),
    },
    async ({ query, limit, type }) => {
      try {
        const memory = await memoryCache.get(userId);
        const results = await memory.search(query, { limit, type, minScore: 0.3 });

        if (results.length === 0) {
          return toolSuccess("İlgili hafıza bulunamadı.");
        }

        const formatted = results
          .map((r, i) => {
            const summary = r.summary || r.content.slice(0, 100);
            return `${i + 1}. [${r.type}] ${summary} (skor: ${r.similarity?.toFixed(2) || "N/A"})`;
          })
          .join("\n");

        console.log(`[Memory] Found ${results.length} memories for query: ${query.slice(0, 30)}...`);
        return toolSuccess(`Bulunan hafızalar:\n${formatted}`);
      } catch (error) {
        return toolError("Arama hatası", error);
      }
    }
  );

export const memoryStatsTool = (userId: number) =>
  tool("memory_stats", "Hafıza istatistiklerini göster.", {}, async () => {
    try {
      const memory = await memoryCache.get(userId);
      const stats = memory.getStats();

      return toolSuccess(`Hafıza İstatistikleri:
- Toplam: ${stats.total}
- Semantic: ${stats.byType.semantic}
- Episodic: ${stats.byType.episodic}
- Procedural: ${stats.byType.procedural}
- Ortalama önem: ${stats.avgImportance.toFixed(2)}`);
    } catch (error) {
      return toolError("İstatistik hatası", error);
    }
  });

export function createMemoryServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-memory",
    version: "1.0.0",
    tools: [rememberTool(userId), recallTool(userId), memoryStatsTool(userId)],
  });
}

export function closeAllMemories(): void {
  memoryCache.closeAll();
}

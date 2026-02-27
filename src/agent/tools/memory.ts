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

export const rememberTool = (userId: number) =>
  tool(
    "remember",
    "Önemli bir bilgiyi uzun vadeli hafızaya kaydet. Kişisel bilgiler, tercihler, gerçekler için kullan.",
    {
      content: z.string().describe("Hatırlanacak bilgi"),
      type: z
        .enum(["semantic", "episodic", "procedural"])
        .default("semantic")
        .describe("semantic=gerçek/tercih (facts.md), episodic=olay (events.md), procedural=nasıl yapılır (facts.md)"),
      section: z
        .string()
        .optional()
        .describe("facts.md için bölüm başlığı (ör: 'Konum', 'Meslek', 'Tercihler'). Episodic için kullanılmaz."),
    },
    async ({ content, type, section }) => {
      try {
        const memory = getMemory(userId);

        if (type === "episodic") {
          await memory.logEvent(content);
          console.log(`[Memory] Event logged for user ${userId}: ${content.slice(0, 60)}...`);
          return toolSuccess(`Olay kaydedildi: ${content.slice(0, 60)}`);
        } else {
          const sectionName = section || inferSection(content, type);
          await memory.storeFact(sectionName, content);
          console.log(`[Memory] Fact stored [${sectionName}] for user ${userId}: ${content.slice(0, 60)}...`);
          return toolSuccess(`Hafızaya kaydedildi [${sectionName}]: ${content.slice(0, 60)}`);
        }
      } catch (error) {
        return toolError("Hafıza hatası", error);
      }
    }
  );

export const recallTool = (userId: number) =>
  tool(
    "recall",
    "Hafızada ara. Daha önce kaydedilen gerçekler ve olayları getir.",
    {
      query: z.string().describe("Arama sorgusu veya 'all' ile tüm hafızayı oku"),
      days: z.number().default(30).describe("Kaç günlük olay geçmişi (sadece events için)"),
    },
    async ({ query, days }) => {
      try {
        const memory = getMemory(userId);

        if (query === "all") {
          const all = await memory.readAll(days);
          if (!all) return toolSuccess("Hafıza boş.");
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
        if (matchingFacts.length > 0) results.push(`**Gerçekler:**\n${matchingFacts.join("\n")}`);
        if (matchingEvents.length > 0) results.push(`**Olaylar:**\n${matchingEvents.join("\n")}`);

        if (results.length === 0) return toolSuccess("İlgili hafıza bulunamadı.");
        return toolSuccess(results.join("\n\n"));
      } catch (error) {
        return toolError("Arama hatası", error);
      }
    }
  );

export const memoryStatsTool = (userId: number) =>
  tool("memory_stats", "Hafıza dosyalarının içeriğini ve boyutunu göster.", {}, async () => {
    try {
      const memory = getMemory(userId);
      const facts = await memory.readFacts();
      const events = await memory.readRecentEvents(90);

      const factLines = facts.split("\n").filter(l => l.trim()).length;
      const eventLines = events.split("\n").filter(l => l.startsWith("- ")).length;

      return toolSuccess(`Hafıza Durumu:
- facts.md: ${factLines} satır
- events.md (90 gün): ${eventLines} olay kaydı`);
    } catch (error) {
      return toolError("İstatistik hatası", error);
    }
  });

export function createMemoryServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-memory",
    version: "2.0.0",
    tools: [rememberTool(userId), recallTool(userId), memoryStatsTool(userId)],
  });
}

// Legacy export — no-op, kept for compatibility
export function closeAllMemories(): void {}

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferSection(content: string, type: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("yaşıyor") || lower.includes("otur") || lower.includes("istanbul") || lower.includes("ankara") || lower.includes("şehir")) return "Konum";
  if (lower.includes("meslek") || lower.includes("çalış") || lower.includes("iş") || lower.includes("mühendis") || lower.includes("yazılım")) return "Meslek";
  if (lower.includes("eş") || lower.includes("karı") || lower.includes("koca") || lower.includes("evli")) return "Aile";
  if (lower.includes("anne") || lower.includes("baba") || lower.includes("kardeş") || lower.includes("çocuk")) return "Aile";
  if (lower.includes("sever") || lower.includes("tercih") || lower.includes("hoşlan") || lower.includes("sevmez")) return "Tercihler";
  if (lower.includes("hedef") || lower.includes("plan") || lower.includes("yapmak istiyor")) return "Hedefler";
  if (type === "procedural") return "Nasıl Yapılır";
  return "Notlar";
}

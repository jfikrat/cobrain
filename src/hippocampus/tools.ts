/**
 * Hippocampus Tools — Memory file manipulation tools for consolidation agent.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FileMemory } from "../memory/file-memory.ts";
import { toolError, toolSuccess } from "../utils/tool-response.ts";
import type { Bot } from "grammy";

export function createHippocampusTools(deps: {
  memory: FileMemory;
  bot: Bot;
  userId: number;
}) {
  const { memory, bot, userId } = deps;

  const readMemoryTool = tool(
    "read_memory_files",
    "facts.md ve events.md dosyalarını oku.",
    {
      days: z.number().default(90).describe("Kaç günlük olay geçmişi"),
    },
    async ({ days }) => {
      try {
        const all = await memory.readAll(days);
        if (!all) return toolSuccess("Hafıza dosyaları boş.");
        return toolSuccess(all);
      } catch (error) {
        return toolError("Okuma hatası", error);
      }
    }
  );

  const archiveEventsTool = tool(
    "archive_old_events",
    "Belirtilen günden daha eski olayları archive/ klasörüne taşı.",
    {
      days_old: z.number().default(90).describe("Kaç günden eski olaylar arşivlensin"),
    },
    async ({ days_old }) => {
      try {
        const count = await memory.archiveOldEvents(days_old);
        if (count === 0) return toolSuccess("Arşivlenecek eski olay bulunamadı.");
        console.log(`[Hippocampus] Archived ${count} date sections (>${days_old} days old)`);
        return toolSuccess(`${count} olay bölümü arşivlendi.`);
      } catch (error) {
        return toolError("Arşivleme hatası", error);
      }
    }
  );

  const updateFactsTool = tool(
    "update_facts",
    "facts.md'de bir bölümü güncelle veya yeni bölüm ekle.",
    {
      section: z.string().describe("Bölüm başlığı (ör: 'Konum', 'Meslek', 'Aile')"),
      content: z.string().describe("Bölüm içeriği"),
    },
    async ({ section, content }) => {
      try {
        await memory.storeFact(section, content);
        console.log(`[Hippocampus] Updated facts [${section}]`);
        return toolSuccess(`facts.md güncellendi: [${section}]`);
      } catch (error) {
        return toolError("Güncelleme hatası", error);
      }
    }
  );

  const logEventTool = tool(
    "log_event",
    "events.md'ye yeni olay ekle.",
    {
      description: z.string().describe("Olay açıklaması"),
      date: z.string().optional().describe("Tarih (YYYY-MM-DD, default: bugün)"),
    },
    async ({ description, date }) => {
      try {
        await memory.logEvent(description, date);
        return toolSuccess(`Olay kaydedildi: ${description}`);
      } catch (error) {
        return toolError("Olay kayıt hatası", error);
      }
    }
  );

  const sendReportTool = tool(
    "send_report",
    "Konsolidasyon özet raporunu Telegram'dan gönder.",
    {
      text: z.string().describe("Rapor metni"),
    },
    async ({ text }) => {
      try {
        await bot.api.sendMessage(userId, `🧠 <b>Hafıza Konsolidasyonu</b>\n\n${text}`, {
          parse_mode: "HTML",
        });
        return toolSuccess("Rapor gönderildi.");
      } catch (error) {
        return toolError("Rapor gönderme hatası", error);
      }
    }
  );

  return createSdkMcpServer({
    name: "cobrain-hippocampus",
    version: "1.0.0",
    tools: [readMemoryTool, archiveEventsTool, updateFactsTool, logEventTool, sendReportTool],
  });
}

/**
 * Stem Tools — MCP tools available to Haiku Stem.
 * Uses createSdkMcpServer from Agent SDK.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../config.ts";
import { think } from "../brain/index.ts";
import { whatsappDB } from "../services/whatsapp-db.ts";
import { markReplied, wasRecentlyReplied } from "../services/reply-dedup.ts";
import { expectations } from "../services/expectations.ts";
import { FileMemory } from "../memory/file-memory.ts";
import { userManager } from "../services/user-manager.ts";
import type { Notebook } from "./notebook.ts";
import type { Bot } from "grammy";

// ── Rate limiter for wake_cortex ─────────────────────────────────────────

class WakeRateLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerHour: number) {}

  canWake(): boolean {
    this.cleanup();
    return this.timestamps.length < this.maxPerHour;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  remaining(): number {
    this.cleanup();
    return Math.max(0, this.maxPerHour - this.timestamps.length);
  }

  private cleanup(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.timestamps = this.timestamps.filter((t) => t > oneHourAgo);
  }
}

// ── Tool creation ──────────────────────────────────────────────────────

export function createStemTools(deps: {
  notebook: Notebook;
  bot: Bot;
  userId: number;
  maxWakesPerHour: number;
}) {
  const { notebook, bot, userId, maxWakesPerHour } = deps;
  const wakeLimiter = new WakeRateLimiter(maxWakesPerHour);

  // ── wake_cortex ────────────────────────────────────────────────────────
  const wakeOpusTool = tool(
    "wake_cortex",
    "Karmaşık karar gerektiğinde Cortex'i uyandır. Rate limit: saatte max " + maxWakesPerHour,
    {
      reason: z.string().describe("Neden Opus gerekli — kısa açıklama"),
      context: z.string().describe("Bağlam bilgisi — mesaj içeriği, kişi, durum"),
      urgency: z.enum(["immediate", "soon"]).default("soon").describe("Aciliyet"),
    },
    async ({ reason, context, urgency }) => {
      if (!wakeLimiter.canWake()) {
        return `Rate limit aşıldı. Kalan wake hakkı: 0/${maxWakesPerHour} (saatlik). Deftere not al ve sonra dene.`;
      }

      wakeLimiter.record();
      console.log(`[Stem] wake_cortex: ${reason} (urgency=${urgency}, remaining=${wakeLimiter.remaining()})`);

      try {
        const response = await think(
          userId,
          `[SENTINEL ESCALATION]\n${reason}\n\nBağlam:\n${context}`,
          "stem",
        );
        return `Cortex cevabı: ${response.content}`;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[Stem] wake_cortex failed:", errMsg);
        // Fallback: send simple Telegram notification
        try {
          await bot.api.sendMessage(
            userId,
            `[Stem] Cortex'e ulaşamadım. Sebep: ${reason}\nBağlam: ${context.slice(0, 200)}`,
          );
        } catch { /* ignore telegram error */ }
        return `Cortex hatası: ${errMsg}. Telegram bildirimi gönderildi (fallback).`;
      }
    },
  );

  // ── send_whatsapp_reply ──────────────────────────────────────────────
  const sendWhatsAppReplyTool = tool(
    "send_whatsapp_reply",
    "WhatsApp mesajına cevap gönder. Dedup kontrolü otomatik yapılır.",
    {
      chatJid: z.string().describe("Hedef chat JID (kişi veya grup)"),
      message: z.string().max(500).describe("Gönderilecek mesaj (max 500 karakter)"),
    },
    async ({ chatJid, message }) => {
      if (wasRecentlyReplied(chatJid)) {
        return `Bu sohbete son 60 saniyede zaten cevap verildi. Dedup: atlandı.`;
      }

      if (!message.trim()) {
        return "Boş mesaj gönderilemez.";
      }

      try {
        const outboxOk = whatsappDB.addToOutbox(chatJid, message);
        if (outboxOk) {
          markReplied(chatJid);

          // Create expectation for reply tracking
          const existing = expectations
            .pending()
            .find((e) => e.target === chatJid && e.type === "whatsapp_reply");
          if (!existing) {
            await expectations.create({
              type: "whatsapp_reply",
              target: chatJid,
              context: `Stem auto-reply: "${message.slice(0, 100)}"`,
              onResolved: "Reply received to stem message",
              userId,
              timeout: config.CORTEX_EXPECTATION_TIMEOUT_MS,
            });
          }
        }
        return outboxOk
          ? `Mesaj gönderildi: "${message.slice(0, 80)}"`
          : "Outbox hatası — mesaj kuyruğa eklenemedi.";
      } catch (err) {
        return `Gönderim hatası: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );

  // ── send_telegram_notification ───────────────────────────────────────
  const sendTelegramNotificationTool = tool(
    "send_telegram_notification",
    "Fekrat'a Telegram bildirimi gönder. Önemli bilgiler için kullan.",
    {
      message: z.string().describe("Bildirim mesajı"),
    },
    async ({ message }) => {
      try {
        await bot.api.sendMessage(userId, message);
        return "Telegram bildirimi gönderildi.";
      } catch (err) {
        return `Telegram hatası: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );

  // ── recall_memory ────────────────────────────────────────────────────
  const recallMemoryTool = tool(
    "recall_memory",
    "Hafızada ara. facts.md (kalıcı bilgiler) + events.md (son olaylar) üzerinde arama yapar.",
    {
      query: z.string().describe("Arama sorgusu veya 'all' ile tüm hafızayı oku"),
      days: z.number().default(30).describe("Kaç günlük olay geçmişi"),
    },
    async ({ query, days }) => {
      try {
        const userFolder = userManager.getUserFolder(userId);
        const memory = new FileMemory(userFolder);

        if (query === "all") {
          const all = await memory.readAll(days);
          return all || "Hafıza boş.";
        }

        const facts = await memory.readFacts();
        const events = await memory.readRecentEvents(days);
        const q = query.toLowerCase();

        const matchingFacts = facts.split("\n").filter(l => l.toLowerCase().includes(q) && l.trim());
        const matchingEvents = events.split("\n").filter(l => l.toLowerCase().includes(q) && l.trim());

        const results: string[] = [];
        if (matchingFacts.length > 0) results.push(`**Gerçekler:**\n${matchingFacts.join("\n")}`);
        if (matchingEvents.length > 0) results.push(`**Olaylar:**\n${matchingEvents.join("\n")}`);

        return results.length > 0 ? results.join("\n\n") : "İlgili hafıza bulunamadı.";
      } catch (err) {
        return `Hafıza arama hatası: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );

  // ── store_memory ─────────────────────────────────────────────────────
  const storeMemoryTool = tool(
    "store_memory",
    "Kalıcı bilgiyi hafızaya kaydet. semantic/procedural → facts.md, episodic → events.md",
    {
      content: z.string().describe("Kaydedilecek bilgi"),
      type: z.enum(["semantic", "episodic", "procedural"]).default("semantic"),
      section: z.string().optional().describe("facts.md bölüm başlığı (ör: 'Konum', 'Tercihler')"),
    },
    async ({ content, type, section }) => {
      try {
        const userFolder = userManager.getUserFolder(userId);
        const memory = new FileMemory(userFolder);

        if (type === "episodic") {
          await memory.logEvent(content);
          return `Olay kaydedildi: ${content.slice(0, 60)}`;
        } else {
          const sectionName = section || inferSection(content);
          await memory.storeFact(sectionName, content);
          return `Hafızaya kaydedildi [${sectionName}]: ${content.slice(0, 60)}`;
        }
      } catch (err) {
        return `Kaydetme hatası: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );

  // ── update_notebook ──────────────────────────────────────────────────
  const updateNotebookTool = tool(
    "update_notebook",
    "Defteri güncelle. Bölüm adı ve yeni içerik ver. Bölümler: Aktif Durum, Bekleyen İşler, Bugünkü Olaylar, Öğrenilenler, Cortex'e Bildirilecekler",
    {
      section: z.string().describe("Bölüm başlığı (## sonrası)"),
      content: z.string().describe("Yeni bölüm içeriği (üzerine yazılır)"),
      append: z.boolean().default(false).describe("true ise bölüme eklenir, false ise üzerine yazılır"),
    },
    async ({ section, content, append }) => {
      try {
        if (append) {
          notebook.appendToSection(section, content);
        } else {
          notebook.writeSection(section, content);
        }
        return `Defter güncellendi: "${section}" ${append ? "(eklendi)" : "(üzerine yazıldı)"}`;
      } catch (err) {
        return `Defter hatası: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );

  // ── check_expectations ───────────────────────────────────────────────
  const checkExpectationsTool = tool(
    "check_expectations",
    "Bekleyen beklentileri listele. Timeout kontrolü için kullan.",
    {},
    async () => {
      const pending = expectations.pending();
      if (pending.length === 0) {
        return "Bekleyen beklenti yok.";
      }

      return pending
        .map((e) => {
          const age = Math.round((Date.now() - e.createdAt) / 60000);
          const timeoutMin = e.timeout > 0 ? Math.round(e.timeout / 60000) : 0;
          return `- [${e.type}] ${e.target}: ${e.context} (${age}dk/${timeoutMin}dk)`;
        })
        .join("\n");
    },
  );

  // ── create_expectation ───────────────────────────────────────────────
  const createExpectationTool = tool(
    "create_expectation",
    "Yeni beklenti oluştur. Birinden cevap bekliyorsan veya takip gereken bir durum varsa kullan.",
    {
      type: z.enum(["whatsapp_reply", "reminder_followup", "user_confirmation", "custom"]).default("whatsapp_reply"),
      target: z.string().describe("Hedef (chatJid, kişi adı vb.)"),
      context: z.string().describe("Neden bekliyoruz"),
      onResolved: z.string().describe("Çözülünce ne yapılacak"),
      timeoutMinutes: z.number().default(30).describe("Timeout süresi (dakika)"),
    },
    async ({ type, target, context, onResolved, timeoutMinutes }) => {
      try {
        const exp = await expectations.create({
          type,
          target,
          context,
          onResolved,
          userId,
          timeout: timeoutMinutes * 60 * 1000,
        });
        return `Beklenti oluşturuldu: ${exp.id} — ${context}`;
      } catch (err) {
        return `Beklenti hatası: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  );

  // ── Build MCP server ─────────────────────────────────────────────────

  return createSdkMcpServer({
    name: "cobrain-stem",
    version: "1.0.0",
    tools: [
      wakeOpusTool,
      sendWhatsAppReplyTool,
      sendTelegramNotificationTool,
      recallMemoryTool,
      storeMemoryTool,
      updateNotebookTool,
      checkExpectationsTool,
      createExpectationTool,
    ],
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function inferSection(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("yaşıyor") || lower.includes("istanbul") || lower.includes("ankara") || lower.includes("şehir")) return "Konum";
  if (lower.includes("meslek") || lower.includes("çalış") || lower.includes("yazılım") || lower.includes("mühendis")) return "Meslek";
  if (lower.includes("eş") || lower.includes("karı") || lower.includes("evli") || lower.includes("anne") || lower.includes("baba")) return "Aile";
  if (lower.includes("sever") || lower.includes("tercih") || lower.includes("hoşlan") || lower.includes("sevmez")) return "Tercihler";
  if (lower.includes("hedef") || lower.includes("plan") || lower.includes("yapmak istiyor")) return "Hedefler";
  return "Notlar";
}

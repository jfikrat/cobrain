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
import { SmartMemory } from "../memory/smart-memory.ts";
import { userManager } from "../services/user-manager.ts";
import type { Notebook } from "./notebook.ts";
import type { Bot } from "grammy";

// ── Rate limiter for wake_opus ─────────────────────────────────────────

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

  // ── wake_opus ────────────────────────────────────────────────────────
  const wakeOpusTool = tool(
    "wake_opus",
    "Karmaşık karar gerektiğinde Opus'u uyandır. Rate limit: saatte max " + maxWakesPerHour,
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
      console.log(`[Stem] wake_opus: ${reason} (urgency=${urgency}, remaining=${wakeLimiter.remaining()})`);

      try {
        const response = await think(
          userId,
          `[SENTINEL ESCALATION]\n${reason}\n\nBağlam:\n${context}`,
          "stem",
        );
        return `Opus cevabı: ${response.content}`;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[Stem] wake_opus failed:", errMsg);
        // Fallback: send simple Telegram notification
        try {
          await bot.api.sendMessage(
            userId,
            `[Stem] Opus'a ulaşamadım. Sebep: ${reason}\nBağlam: ${context.slice(0, 200)}`,
          );
        } catch { /* ignore telegram error */ }
        return `Opus hatası: ${errMsg}. Telegram bildirimi gönderildi (fallback).`;
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
    "Hafızada ara. Kişi bilgisi, geçmiş olaylar, kurallar için kullan.",
    {
      query: z.string().describe("Arama sorgusu"),
      limit: z.number().default(3).describe("Maksimum sonuç"),
    },
    async ({ query, limit }) => {
      let memory: SmartMemory | null = null;
      try {
        const userFolder = userManager.getUserFolder(userId);
        memory = new SmartMemory(userFolder, userId);
        const results = await memory.search(query, { limit, minScore: 0.3 });

        if (results.length === 0) {
          return "İlgili hafıza bulunamadı.";
        }

        return results
          .map((r, i) => {
            const summary = r.summary || r.content.slice(0, 120);
            return `${i + 1}. [${r.type}] ${summary}`;
          })
          .join("\n");
      } catch (err) {
        return `Hafıza arama hatası: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        try { memory?.close(); } catch { /* ignore */ }
      }
    },
  );

  // ── store_memory ─────────────────────────────────────────────────────
  const storeMemoryTool = tool(
    "store_memory",
    "Kalıcı bilgiyi hafızaya kaydet. Konsolidasyon sırasında önemli bilgiler için kullan.",
    {
      content: z.string().describe("Kaydedilecek bilgi"),
      type: z.enum(["semantic", "episodic", "procedural"]).default("semantic"),
      importance: z.number().min(0).max(1).default(0.5),
    },
    async ({ content, type, importance }) => {
      let memory: SmartMemory | null = null;
      try {
        const userFolder = userManager.getUserFolder(userId);
        memory = new SmartMemory(userFolder, userId);
        const id = await memory.store({
          content,
          type,
          importance,
          source: "stem",
        });
        return `Hafızaya kaydedildi (ID: ${id})`;
      } catch (err) {
        return `Kaydetme hatası: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        try { memory?.close(); } catch { /* ignore */ }
      }
    },
  );

  // ── update_notebook ──────────────────────────────────────────────────
  const updateNotebookTool = tool(
    "update_notebook",
    "Defteri güncelle. Bölüm adı ve yeni içerik ver. Bölümler: Aktif Durum, Bekleyen İşler, Bugünkü Olaylar, Öğrenilenler, Opus'a Bildirilecekler",
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

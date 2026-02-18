/**
 * BrainLoop — Unified autonomous loop (Sentinel edition)
 *
 * Architecture:
 * - fastTick (30s): WhatsApp poll → sentinel events, due reminders → sentinel events
 * - slowTick (5min): periodic check → sentinel event, code review cycle
 *
 * AI reasoning is now handled entirely by the Sentinel (Haiku).
 * Gemini Flash and ActionExecutor have been removed.
 */

import { resolve } from "node:path";
import { Bot } from "grammy";
import { config } from "../config.ts";
import { userManager } from "./user-manager.ts";
import { getGoalsService } from "./goals.ts";
import { SmartMemory } from "../memory/smart-memory.ts";
import { getSessionState, updateSessionState } from "./session-state.ts";
import { expectations } from "./expectations.ts";
import { heartbeat } from "./heartbeat.ts";
import { whatsappDB } from "./whatsapp-db.ts";
import { getTaskQueue } from "./task-queue.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import { chat, isUserBusy } from "../agent/chat.ts";

// ── Constants ────────────────────────────────────────────────────────────

const FAST_TICK_MS = 30_000;     // 30 seconds
const SLOW_TICK_MS = 300_000;    // 5 minutes

const CODE_REVIEW_FILES = [
  "src/agent/chat.ts",
  "src/services/brain-loop.ts",
  "src/brain/index.ts",
  "src/memory/smart-memory.ts",
  "src/sentinel/sentinel.ts",
  "src/channels/telegram.ts",
  "src/agent/prompts.ts",
  "src/brain/router-lite.ts",
  "src/brain/event-store.ts",
  "src/services/scheduler.ts",
  "src/services/task-queue.ts",
  "src/config.ts",
];

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20250121";
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

// ── BrainLoop Class ──────────────────────────────────────────────────────

class BrainLoop {
  private bot: Bot | null = null;
  private fastIntervalId: ReturnType<typeof setInterval> | null = null;
  private slowIntervalId: ReturnType<typeof setInterval> | null = null;
  private codeReviewIndex = 0;
  private lastCodeReviewDate: string | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(botInstance: Bot): void {
    this.bot = botInstance;
    if (!config.MINIMAL_AUTONOMY) {
      this.restoreState();
    }

    this.fastIntervalId = setInterval(() => {
      this.fastTick().catch(err => console.error("[BrainLoop] fastTick error:", err));
    }, FAST_TICK_MS);

    this.slowIntervalId = setInterval(() => {
      this.slowTick().catch(err => console.error("[BrainLoop] slowTick error:", err));
    }, SLOW_TICK_MS);

    console.log(`[BrainLoop] Started (fast: ${FAST_TICK_MS}ms, slow: ${SLOW_TICK_MS}ms)`);
  }

  stop(): void {
    if (this.fastIntervalId) {
      clearInterval(this.fastIntervalId);
      this.fastIntervalId = null;
    }
    if (this.slowIntervalId) {
      clearInterval(this.slowIntervalId);
      this.slowIntervalId = null;
    }
    if (!config.MINIMAL_AUTONOMY) {
      this.persistState();
    }
    console.log("[BrainLoop] Stopped");
  }

  // ── Fast Tick (30s) ─────────────────────────────────────────────────

  private async fastTick(): Promise<void> {
    heartbeat("brain_loop", { event: "fast_tick" });

    try {
      await this.pollWhatsApp();
    } catch (err) {
      console.error("[BrainLoop] pollWhatsApp error:", err);
    }

    try {
      await this.checkDueReminders();
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }
  }

  // ── Slow Tick (5min) ────────────────────────────────────────────────

  private async slowTick(): Promise<void> {
    heartbeat("brain_loop", { event: "slow_tick" });

    // Periodic check via main agent
    const userId = config.MY_TELEGRAM_ID;
    if (!isUserBusy(userId)) {
      try {
        await chat(
          userId,
          `🔄 Periyodik kontrol — ${new Date().toLocaleString("tr-TR")}. Takip etmeni gerektiren bir şey var mı?`,
        );
      } catch (err) {
        console.error("[BrainLoop] periodic_check error:", err);
      }
    }

    // Code review cycle is disabled in minimal autonomy mode.
    if (!config.MINIMAL_AUTONOMY) {
      try {
        await this.maybeRunCodeReview(config.MY_TELEGRAM_ID);
      } catch (err) {
        console.error("[BrainLoop] maybeRunCodeReview error:", err);
      }

      this.persistState();
    }
  }

  // ── WhatsApp Polling → Sentinel Events ──────────────────────────────

  private async pollWhatsApp(): Promise<void> {
    if (!this.bot || !whatsappDB.isAvailable()) return;

    const allNotifications = whatsappDB.getPendingNotifications(10);
    if (allNotifications.length === 0) return;

    const processedIds = new Set<number>();
    const userId = config.MY_TELEGRAM_ID;
    const maxAgeSec = config.WHATSAPP_STALE_MAX_AGE_SEC;
    const allowedGroupJids = config.WHATSAPP_ALLOWED_GROUP_JIDS
      ? config.WHATSAPP_ALLOWED_GROUP_JIDS.split(",").map(j => j.trim()).filter(Boolean)
      : [];

    const nowSec = Math.floor(Date.now() / 1000);
    const notifications: typeof allNotifications = [];
    const staleDMs: typeof allNotifications = [];
    const statusUpdateIds: number[] = [];

    for (const n of allNotifications) {
      if (n.chat_jid === "status@broadcast") {
        statusUpdateIds.push(n.id);
        continue;
      }
      const msgTs = n.message_timestamp || 0;
      if (msgTs === 0 || (nowSec - msgTs) < maxAgeSec) {
        notifications.push(n);
      } else if (!n.is_group) {
        staleDMs.push(n);
      }
    }

    // Mark status updates as read
    if (statusUpdateIds.length > 0) {
      whatsappDB.markNotificationsRead(statusUpdateIds);
      for (const id of statusUpdateIds) processedIds.add(id);
    }

    // Mark stale as read
    const staleIds = allNotifications
      .filter(n => !notifications.includes(n))
      .map(n => n.id);
    if (staleIds.length > 0) {
      whatsappDB.markNotificationsRead(staleIds);
      for (const id of staleIds) processedIds.add(id);
      console.log(`[BrainLoop] Skipped ${staleIds.length} stale notifications`);
    }

    // Notify about stale DMs
    if (staleDMs.length > 0) {
      const senderNames = [...new Set(staleDMs.map(n => n.sender_name || n.chat_jid.split("@")[0] || "?"))];
      const staleMsg = `<i>${staleDMs.length} eski WhatsApp mesaji atlandi: ${senderNames.map(s => escapeHtml(s)).join(", ")}</i>`;
      try {
        await this.bot.api.sendMessage(userId, staleMsg, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[BrainLoop] Stale DM notification failed:", err);
      }
    }

    if (notifications.length === 0) return;

    const dms = notifications.filter(n => !n.is_group);
    const groupMsgs = notifications.filter(n => n.is_group);

    // ── Feed DMs to main agent ────────────────────────────────────────
    if (dms.length > 0) {
      const bySender = new Map<string, typeof dms>();
      for (const notif of dms) {
        const key = notif.chat_jid;
        if (!bySender.has(key)) bySender.set(key, []);
        bySender.get(key)!.push(notif);
      }

      for (const [chatJid, msgs] of bySender) {
        if (isUserBusy(userId)) {
          console.log(`[BrainLoop] User busy, deferring DM from ${chatJid}`);
          continue;
        }
        try {
          const senderName = msgs[0]!.sender_name || chatJid.split("@")[0] || "?";
          const msgTexts = msgs.map(m => m.content || "[medya]").join("\n");
          await chat(
            userId,
            `📱 WhatsApp DM — ${senderName} (${chatJid}):\n${msgTexts}`,
          );
          const chatIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(chatIds);
          for (const id of chatIds) processedIds.add(id);
        } catch (chatError) {
          console.error(`[BrainLoop] DM chat ${chatJid} error:`, chatError);
        }
      }
    }

    // ── Feed Group Messages to main agent ─────────────────────────────
    if (groupMsgs.length > 0) {
      const byGroup = new Map<string, typeof groupMsgs>();
      for (const notif of groupMsgs) {
        const key = notif.chat_jid;
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(notif);
      }

      for (const [groupJid, msgs] of byGroup) {
        if (isUserBusy(userId)) {
          console.log(`[BrainLoop] User busy, deferring group ${groupJid}`);
          continue;
        }
        try {
          const replyAllowed = allowedGroupJids.length > 0 && allowedGroupJids.includes(groupJid);
          const groupName = msgs[0]!.sender_name?.split(" @ ")[1] || groupJid;
          const msgTexts = msgs.map(m => `${m.sender_name || "?"}: ${m.content || "[medya]"}`).join("\n");
          await chat(
            userId,
            `📱 WhatsApp Grup — ${groupName} (${groupJid}, cevap: ${replyAllowed ? "evet" : "hayır"}):\n${msgTexts}`,
          );
          const groupIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(groupIds);
          for (const id of groupIds) processedIds.add(id);
        } catch (groupError) {
          console.error(`[BrainLoop] Group ${groupJid} error:`, groupError);
        }
      }
    }

    heartbeat("whatsapp_notifications", {
      sent: notifications.length,
      dms: dms.length,
      groups: groupMsgs.length,
      stale: staleIds.length,
    });
  }

  // ── Due Reminders → Sentinel Events ──────────────────────────────────

  private async checkDueReminders(): Promise<void> {
    const userId = config.MY_TELEGRAM_ID;

    try {
      const db = await userManager.getUserDb(userId);
      const goalsService = await getGoalsService(db, userId);
      const dueReminders = goalsService.getDueReminders();

      for (const reminder of dueReminders) {
        if (!isUserBusy(userId)) {
          await chat(
            userId,
            `⏰ Hatırlatıcı: ${reminder.title}${reminder.message ? `\n${reminder.message}` : ""}`,
          );
        }
        // Always mark as sent to prevent infinite loop (regardless of busy state)
        goalsService.markReminderSent(reminder.id);
      }
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }
  }

  // ── Code Review Cycle ──────────────────────────────────────────────

  private async maybeRunCodeReview(userId: number): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().slice(0, 10);

    if (hour !== 14) return;
    if (this.lastCodeReviewDate === today) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const filePath = CODE_REVIEW_FILES[this.codeReviewIndex % CODE_REVIEW_FILES.length]!;
    this.codeReviewIndex++;
    this.lastCodeReviewDate = today;

    const fullPath = resolve(PROJECT_ROOT, filePath);

    console.log(`[BrainLoop:CodeReview] Starting daily review: ${filePath}`);

    try {
      const file = Bun.file(fullPath);
      if (!(await file.exists())) {
        console.warn(`[BrainLoop:CodeReview] File not found: ${fullPath}`);
        return;
      }

      const content = await file.text();
      const truncated = content.length > 4000
        ? content.slice(0, 4000) + "\n\n[... truncated ...]"
        : content;

      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 500,
          system: `Sen bir kod review uzmanısın. Verilen TypeScript dosyasını analiz et.
Her gözlemi şu formatta JSON array olarak döndür:
[{"type": "bug"|"improvement"|"performance"|"architecture"|"cleanup", "priority": "low"|"medium"|"high", "observation": "kısa açıklama", "suggestion": "öneri"}]
Bulgu yoksa boş array: []. Maksimum 3 gözlem.`,
          messages: [{ role: "user", content: `Dosya: ${filePath}\n\n${truncated}` }],
        }),
      });

      if (!response.ok) {
        console.error(`[BrainLoop:CodeReview] Haiku API error: ${response.status}`);
        return;
      }

      const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
      const text = data.content.find(c => c.type === "text")?.text || "";

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const observations = JSON.parse(jsonMatch[0]) as Array<{
        type: string; priority: string; observation: string; suggestion: string;
      }>;

      if (observations.length === 0) {
        console.log(`[BrainLoop:CodeReview] No issues in ${filePath}`);
        return;
      }

      const userFolder = userManager.getUserFolder(userId);
      const memory = new SmartMemory(userFolder, userId);
      const highPriorityBugs: string[] = [];

      for (const obs of observations) {
        const memContent = `[code-obs] [${obs.type}] [${obs.priority}] Dosya: ${filePath}\nGözlem: ${obs.observation}\nÖneri: ${obs.suggestion}`;
        await memory.store({
          type: "semantic",
          content: memContent,
          summary: `[code-obs] ${filePath}: ${obs.observation.slice(0, 80)}`,
          importance: obs.priority === "high" ? 0.9 : obs.priority === "medium" ? 0.7 : 0.5,
          source: "code-review-cycle",
          metadata: { file: filePath, obsType: obs.type, priority: obs.priority, date: today },
        });

        if (obs.priority === "high" && obs.type === "bug") {
          highPriorityBugs.push(`${filePath}: ${obs.observation}`);
        }
      }

      memory.close();
      console.log(`[BrainLoop:CodeReview] ${observations.length} observation(s) saved for ${filePath}`);

      if (highPriorityBugs.length > 0 && this.bot) {
        const bugMsg = highPriorityBugs.map(b => `- ${b}`).join("\n");
        await this.bot.api.sendMessage(
          userId,
          `Code review'da yüksek öncelikli bug buldum:\n${bugMsg}\n\nDetay: recall("code-obs") ile bakabilirsin.`,
        );
      }
    } catch (err) {
      console.error(`[BrainLoop:CodeReview] Error reviewing ${filePath}:`, err);
    }
  }

  // ── State Persistence ──────────────────────────────────────────────

  private restoreState(): void {
    try {
      const state = getSessionState(config.MY_TELEGRAM_ID);
      this.lastCodeReviewDate = state.lastCodeReviewDate;
      this.codeReviewIndex = state.codeReviewIndex;
      console.log(`[BrainLoop] State restored: codeReviewIdx=${this.codeReviewIndex}`);
    } catch (err) {
      console.warn("[BrainLoop] State restore failed:", err);
    }
  }

  private persistState(): void {
    try {
      updateSessionState(config.MY_TELEGRAM_ID, {
        codeReviewIndex: this.codeReviewIndex,
        lastCodeReviewDate: this.lastCodeReviewDate,
      });
    } catch (err) {
      console.warn("[BrainLoop] State persist failed:", err);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

export const brainLoop = new BrainLoop();

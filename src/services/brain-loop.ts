/**
 * BrainLoop — Unified autonomous loop (Cortex direct edition)
 *
 * Architecture:
 * - fastTick (30s): WhatsApp group poll → inbox, due reminders → inbox
 * - slowTick (5min): periodic check → inbox, code review cycle
 *
 * WA DMs are handled by the standalone WA Agent process (src/agents/wa/index.ts).
 * All AI reasoning is handled by Cortex (Sonnet) directly via inbox.
 */

import { resolve } from "node:path";
import { Bot } from "grammy";
import { config } from "../config.ts";
import { userManager } from "./user-manager.ts";
import { getRemindersService } from "./reminders.ts";
import { FileMemory } from "../memory/file-memory.ts";
import { getSessionState, updateSessionState } from "./session-state.ts";
import { expectations } from "./expectations.ts";
import { heartbeat } from "./heartbeat.ts";
import { whatsappDB } from "./whatsapp-db.ts";
import { getTaskQueue } from "./task-queue.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import { chat, isUserBusy } from "../agent/chat.ts";
import { mneme } from "../mneme/mneme.ts";
import { inbox } from "./inbox.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

async function sendLogToChannel(bot: Bot, eventType: string, response: Awaited<ReturnType<typeof chat>>): Promise<void> {
  if (!config.LOG_CHANNEL_ID) return;
  try {
    const tools = response.toolsUsed.length > 0 ? response.toolsUsed.join(", ") : "—";
    const preview = response.content.slice(0, 300).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const msg = `🤖 <b>${eventType}</b>\n\n${preview}${response.content.length > 300 ? "…" : ""}\n\n🔧 <code>${tools}</code> | 💰 $${response.totalCost.toFixed(4)} | 🔄 ${response.numTurns} turn`;
    await bot.api.sendMessage(config.LOG_CHANNEL_ID, msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[BrainLoop] Log channel send failed:", err);
  }
}

async function sendRawLog(bot: Bot, msg: string): Promise<void> {
  if (!config.LOG_CHANNEL_ID) return;
  try {
    await bot.api.sendMessage(config.LOG_CHANNEL_ID, msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[BrainLoop] Log channel send failed:", err);
  }
}

// ── Constants ────────────────────────────────────────────────────────────

const FAST_TICK_MS = config.BRAIN_LOOP_FAST_TICK_MS;
const SLOW_TICK_MS = config.BRAIN_LOOP_SLOW_TICK_MS;

const CODE_REVIEW_FILES = [
  "src/agent/chat.ts",
  "src/services/brain-loop.ts",
  "src/brain/index.ts",
  "src/memory/file-memory.ts",
  "src/channels/telegram.ts",
  "src/agent/prompts.ts",
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
  private lastProactiveCheckHour: string | null = null;

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

    try {
      await this.processInbox();
    } catch (err) {
      console.error("[BrainLoop] processInbox error:", err);
    }
  }

  // ── Slow Tick (5min) ────────────────────────────────────────────────

  private async slowTick(): Promise<void> {
    heartbeat("brain_loop", { event: "slow_tick" });

    // Mneme: memory consolidation during sleep hours (03:00-03:59)
    if (mneme.shouldRun() && this.bot) {
      mneme.run(config.MY_TELEGRAM_ID, this.bot).catch(err =>
        console.error("[BrainLoop] mneme error:", err)
      );
    }

    try {
      await this.checkExpiredExpectations();
    } catch (err) {
      console.error("[BrainLoop] checkExpiredExpectations error:", err);
    }

    try {
      await this.checkProactiveBehaviors();
    } catch (err) {
      console.error("[BrainLoop] checkProactiveBehaviors error:", err);
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

  // ── WhatsApp Group Polling → Inbox ───────────────────────────────────
  // WA DMs are handled by the standalone WA Agent process.
  // This method only processes group messages from the notifications table.

  private async pollWhatsApp(): Promise<void> {
    if (!this.bot || !whatsappDB.isAvailable()) return;

    const allNotifications = whatsappDB.getPendingNotifications(10);
    if (allNotifications.length === 0) {
      heartbeat("whatsapp_notifications", { sent: 0, dms: 0, groups: 0, stale: 0 });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const maxAgeSec = config.WHATSAPP_STALE_MAX_AGE_SEC;
    const allowedGroupJids = config.WHATSAPP_ALLOWED_GROUP_JIDS
      ? config.WHATSAPP_ALLOWED_GROUP_JIDS.split(",").map(j => j.trim()).filter(Boolean)
      : [];

    // Mark status updates as read immediately
    const statusIds = allNotifications.filter(n => n.chat_jid === "status@broadcast").map(n => n.id);
    if (statusIds.length > 0) whatsappDB.markNotificationsRead(statusIds);

    // DMs → mark as read (handled by WA Agent)
    const dmIds = allNotifications
      .filter(n => !n.is_group && n.chat_jid !== "status@broadcast")
      .map(n => n.id);
    if (dmIds.length > 0) whatsappDB.markNotificationsRead(dmIds);

    // Group messages
    const allGroupMsgs = allNotifications.filter(n => n.is_group);
    const validGroups: typeof allGroupMsgs = [];
    const staleCount: number[] = [];

    for (const n of allGroupMsgs) {
      const msgTs = n.message_timestamp || 0;
      if (msgTs === 0 || (nowSec - msgTs) < maxAgeSec) {
        validGroups.push(n);
      } else {
        staleCount.push(n.id);
      }
    }

    if (staleCount.length > 0) {
      whatsappDB.markNotificationsRead(staleCount);
      console.log(`[BrainLoop] Skipped ${staleCount.length} stale group notifications`);
    }

    if (validGroups.length > 0) {
      const byGroup = new Map<string, typeof validGroups>();
      for (const notif of validGroups) {
        if (!byGroup.has(notif.chat_jid)) byGroup.set(notif.chat_jid, []);
        byGroup.get(notif.chat_jid)!.push(notif);
      }

      for (const [groupJid, msgs] of byGroup) {
        const groupName = msgs[0]!.sender_name?.split(" @ ")[1] || groupJid;
        try {
          const replyAllowed = allowedGroupJids.length > 0 && allowedGroupJids.includes(groupJid);
          const msgTexts = msgs.map(m => `${m.sender_name || "?"}: ${m.content || "[medya]"}`).join("\n");

          await inbox.push({
            from: "brain-loop",
            subject: `[whatsapp_group] ${groupName}`,
            body: `Bağlam: [whatsapp_group] ${groupName}\nCevap izni: ${replyAllowed ? "evet" : "hayır"}\n\n${msgTexts}`,
            priority: "normal",
            ttlMs: 2 * 60 * 60 * 1000,
          });
          console.log(`[BrainLoop] WA Grup → Inbox: ${groupName}`);

          whatsappDB.markNotificationsRead(msgs.map(m => m.id));
        } catch (groupError) {
          console.error(`[BrainLoop] Group ${groupJid} error:`, groupError);
          if (this.bot) await sendRawLog(this.bot, `❌ <b>WA Grup hata</b> — ${escapeHtml(groupName)}\n<code>${String(groupError).slice(0, 200)}</code>`);
        }
      }
    }

    heartbeat("whatsapp_notifications", {
      sent: validGroups.length,
      dms: dmIds.length,
      groups: validGroups.length,
      stale: staleCount.length,
    });
  }

  // ── Due Reminders → Inbox ────────────────────────────────────────────

  private async checkDueReminders(): Promise<void> {
    const userId = config.MY_TELEGRAM_ID;

    try {
      const db = await userManager.getUserDb(userId);
      const remindersService = await getRemindersService(db, userId);
      const dueReminders = remindersService.getDueReminders();

      for (const reminder of dueReminders) {
        try {
          await inbox.push({
            from: "brain-loop",
            subject: `[hatırlatıcı] ${reminder.title}`,
            body: `[OTONOM OLAY — Hatırlatıcı]\n${reminder.title}${reminder.message ? `\n${reminder.message}` : ""}`,
            priority: "urgent",
            ttlMs: 30 * 60 * 1000,
          });
          console.log(`[BrainLoop] Hatırlatıcı → Inbox: ${reminder.title}`);
        } catch (err) {
          console.error("[BrainLoop] reminder error:", err);
          if (this.bot) await sendRawLog(this.bot, `❌ <b>Hatırlatıcı hata</b> — ${escapeHtml(reminder.title)}\n<code>${String(err).slice(0, 200)}</code>`);
        }
        // Başarı veya hata — mark et (hata durumunda sonsuz döngüyü önle)
        remindersService.markReminderSent(reminder.id);
      }
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }
  }

  // ── Expired Expectations → Inbox ─────────────────────────────────────

  private async checkExpiredExpectations(): Promise<void> {
    const expired = expectations.cleanExpired();
    if (expired.length === 0) return;

    for (const exp of expired) {
      await inbox.push({
        from: "brain-loop",
        subject: `[beklenti_timeout] ${exp.type} — ${exp.target}`,
        body: `Beklenti zaman aşımına uğradı:\nTür: ${exp.type}\nHedef: ${exp.target}\nBağlam: ${exp.context || "yok"}\nOnResolved: ${exp.onResolved || "yok"}`,
        priority: "normal",
        ttlMs: 60 * 60 * 1000,
      });
      console.log(`[BrainLoop] Expectation timeout → Inbox: [${exp.type}] ${exp.target}`);
    }
  }

  // ── Proactive Behaviors Check ─────────────────────────────────────────
  //
  // Saatte bir, aktif saatlerde (07-23) Cortex'e "behaviors.md'ini kontrol et"
  // mesajı gönderir. Hangi davranışın ne zaman çalışacağı tamamen behaviors.md'de
  // tanımlı — bu kod sadece tetikleyicidir, hiçbir davranış hardcode değil.

  private async checkProactiveBehaviors(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // Sadece aktif saatlerde (07:00-23:00)
    if (hour < 7 || hour >= 23) return;

    // Saatte bir kez
    const hourKey = `${now.toISOString().slice(0, 10)}-${String(hour).padStart(2, "0")}`;
    if (this.lastProactiveCheckHour === hourKey) return;

    this.lastProactiveCheckHour = hourKey;

    const dayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
    const dayName = dayNames[now.getDay()];
    const timeStr = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = now.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });

    await inbox.push({
      from: "scheduler",
      subject: `Proaktif kontrol — ${timeStr}`,
      body: `Saat: ${timeStr} (${dayName}, ${dateStr})\n\nbehaviors.md'ini oku. Şu an yapman gereken proaktif bir şey var mı?\n\nEvet → yap ve gerekirse Telegram'a bildir.\nHayır → sessiz kal, bu mesajı işaretlenmiş say.`,
      priority: "normal",
      ttlMs: 55 * 60 * 1000, // 55 dakikada expire — bir sonraki tick'te yenisi gelir
    });

    console.log(`[BrainLoop] Proactive check pushed: ${hourKey}`);
  }

  // ── Inbox Processing ─────────────────────────────────────────────────

  private async processInbox(): Promise<void> {
    const pendingItem = inbox.pending()[0];
    if (!pendingItem) return;

    // Kullanıcı konuşuyorsa bekle
    if (isUserBusy(config.MY_TELEGRAM_ID)) return;

    const prompt = [
      `[GELEN KUTUSU — ${pendingItem.from.toUpperCase()}]`,
      `Konu: ${pendingItem.subject}`,
      ``,
      pendingItem.body,
    ].join("\n");

    console.log(`[BrainLoop] Inbox item işleniyor: "${pendingItem.subject}"`);

    // Kullanıcıya "çalışıyor" göster — her 4s yenile
    const userId = config.MY_TELEGRAM_ID;
    if (this.bot) this.bot.api.sendChatAction(userId, "typing").catch(() => {});
    const typingInterval = this.bot
      ? setInterval(() => this.bot!.api.sendChatAction(userId, "typing").catch(() => {}), 4000)
      : null;

    chat(userId, prompt)
      .then(async response => {
        if (typingInterval) clearInterval(typingInterval);
        await inbox.markProcessed(pendingItem.id);
        if (this.bot) sendLogToChannel(this.bot, `📬 Inbox [${pendingItem.from}] — ${pendingItem.subject.slice(0, 60)}`, response);
      })
      .catch(err => {
        if (typingInterval) clearInterval(typingInterval);
        console.error("[BrainLoop] Inbox işleme hatası:", err);
      });
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
      const fileMemory = new FileMemory(userFolder);
      const highPriorityBugs: string[] = [];

      for (const obs of observations) {
        const entry = `[code-obs] [${obs.type}/${obs.priority}] ${filePath}: ${obs.observation} → ${obs.suggestion}`;
        await fileMemory.logEvent(entry);

        if (obs.priority === "high" && obs.type === "bug") {
          highPriorityBugs.push(`${filePath}: ${obs.observation}`);
        }
      }

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
      this.lastProactiveCheckHour = state.lastProactiveCheckHour ?? null;
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
        lastProactiveCheckHour: this.lastProactiveCheckHour,
      });
    } catch (err) {
      console.warn("[BrainLoop] State persist failed:", err);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

export const brainLoop = new BrainLoop();

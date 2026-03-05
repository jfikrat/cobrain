/**
 * BrainLoop — Unified autonomous loop (Cortex direct edition)
 *
 * Architecture:
 * - fastTick (30s): due reminders → inbox
 * - slowTick (5min): periodic check → inbox, code review cycle
 *
 * All AI reasoning is handled by Cortex (Sonnet) directly via inbox.
 */

import { Bot } from "grammy";
import { config } from "../config.ts";
import { userManager } from "./user-manager.ts";
import { getRemindersService } from "./reminders.ts";
import { getSessionState, updateSessionState } from "./session-state.ts";
import { expectations } from "./expectations.ts";
import { heartbeat } from "./heartbeat.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import { chat, isUserBusy } from "../agent/chat.ts";
import { mneme } from "../mneme/mneme.ts";
import { inbox } from "./inbox.ts";
import { readLoopConfig, type LoopConfig, DEFAULT_LOOP_CONFIG } from "../agent/tools/agent-loop.ts";
import { hasPendingWAMessages } from "../agent/tools/whatsapp.ts";
import { TR_DAY_NAMES, ACTIVE_HOUR_START, ACTIVE_HOUR_END, REMINDER_INBOX_TTL_MS, EXPECTATION_INBOX_TTL_MS, PROACTIVE_INBOX_TTL_MS } from "../constants.ts";

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


// ── BrainLoop Class ──────────────────────────────────────────────────────

class BrainLoop {
  private bot: Bot | null = null;
  private fastIntervalId: ReturnType<typeof setInterval> | null = null;
  private slowIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastProactiveCheckHour: string | null = null;

  // Agent loop state
  private agentLoopCache = new Map<string, { config: LoopConfig; loadedAt: number }>();
  private agentLastTriggered = new Map<string, number>();

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
      await this.checkDueReminders();
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }

    try {
      await this.checkAgentLoops();
    } catch (err) {
      console.error("[BrainLoop] checkAgentLoops error:", err);
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

    if (!config.MINIMAL_AUTONOMY) {
      this.persistState();
    }
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
            ttlMs: REMINDER_INBOX_TTL_MS,
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
        ttlMs: EXPECTATION_INBOX_TTL_MS,
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
    if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return;

    // Saatte bir kez
    const hourKey = `${now.toISOString().slice(0, 10)}-${String(hour).padStart(2, "0")}`;
    if (this.lastProactiveCheckHour === hourKey) return;

    this.lastProactiveCheckHour = hourKey;

    const dayName = TR_DAY_NAMES[now.getDay()];
    const timeStr = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = now.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });

    await inbox.push({
      from: "scheduler",
      subject: `Proaktif kontrol — ${timeStr}`,
      body: `Saat: ${timeStr} (${dayName}, ${dateStr})\n\nbehaviors.md'ini oku. Şu an yapman gereken proaktif bir şey var mı?\n\nEvet → yap ve gerekirse Telegram'a bildir.\nHayır → sessiz kal, bu mesajı işaretlenmiş say.`,
      priority: "normal",
      ttlMs: PROACTIVE_INBOX_TTL_MS, // 55 dakikada expire — bir sonraki tick'te yenisi gelir
    });

    console.log(`[BrainLoop] Proactive check pushed: ${hourKey}`);
  }

  // ── Agent Loop System ──────────────────────────────────────────────
  //
  // Her fastTick'te çalışır. Agent'ların loop.json dosyasını okuyup
  // dinamik olarak heartbeat gönderir. Precondition registry ile
  // lightweight check yapabilir.

  private static readonly LOOP_CACHE_TTL_MS = 30_000; // 30s cache

  private static readonly PRECONDITIONS: Record<string, () => boolean> = {
    hasPendingWAMessages: () => hasPendingWAMessages(),
  };

  private async getLoopConfig(agentId: string): Promise<LoopConfig> {
    const cached = this.agentLoopCache.get(agentId);
    if (cached && Date.now() - cached.loadedAt < BrainLoop.LOOP_CACHE_TTL_MS) {
      return cached.config;
    }

    const loopConfig = await readLoopConfig(agentId);
    this.agentLoopCache.set(agentId, { config: loopConfig, loadedAt: Date.now() });
    return loopConfig;
  }

  private async checkAgentLoops(): Promise<void> {
    if (!config.COBRAIN_HUB_ID || !this.bot) return;

    const now = Date.now();
    const hour = new Date().getHours();

    // Sadece aktif saatlerde (07:00-23:00)
    if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return;

    const { listActiveAgents } = await import("../agents/registry.ts");
    const agents = listActiveAgents();
    if (agents.length === 0) return;

    for (const agent of agents) {
      try {
        const loopConfig = await this.getLoopConfig(agent.id);

        // Expired override temizle
        if (loopConfig.activeUntil && loopConfig.activeUntil < now) {
          loopConfig.activeIntervalMs = null;
          loopConfig.activeUntil = null;
          loopConfig.reason = null;
          // Cache güncelle (dosya yazma pahalı, sadece cache'i güncelle)
          this.agentLoopCache.set(agent.id, { config: loopConfig, loadedAt: Date.now() });
        }

        // Effective interval hesapla
        const effectiveInterval = (loopConfig.activeUntil && loopConfig.activeUntil > now && loopConfig.activeIntervalMs)
          ? loopConfig.activeIntervalMs
          : loopConfig.intervalMs;

        // Son tetiklemeden bu yana yeterli süre geçti mi?
        const lastTriggered = this.agentLastTriggered.get(agent.id) ?? 0;
        if (now - lastTriggered < effectiveInterval) continue;

        // Precondition varsa kontrol et
        if (loopConfig.precondition) {
          const check = BrainLoop.PRECONDITIONS[loopConfig.precondition];
          if (check && !check()) continue;
        }

        // Heartbeat gönder
        const nowDate = new Date();
        const dayName = TR_DAY_NAMES[nowDate.getDay()];
        const timeStr = `${String(nowDate.getHours()).padStart(2, "0")}:${String(nowDate.getMinutes()).padStart(2, "0")}`;
        const dateStr = nowDate.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });

        await this.bot.api.sendMessage(config.COBRAIN_HUB_ID,
          `[HEARTBEAT]\nSaat: ${timeStr} (${dayName}, ${dateStr})\n\nbehaviors.md'ini oku. Şu an yapman gereken proaktif bir şey var mı?\nEvet → yap. Hayır → sessiz kal.`,
          { message_thread_id: agent.topicId },
        );

        this.agentLastTriggered.set(agent.id, now);
        console.log(`[BrainLoop] Agent loop: ${agent.id} (interval: ${effectiveInterval}ms${loopConfig.activeUntil ? ", active mode" : ""})`);
      } catch (err) {
        console.warn(`[BrainLoop] Agent loop failed for ${agent.id}:`, err);
      }
    }
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

  // ── State Persistence ──────────────────────────────────────────────

  private restoreState(): void {
    try {
      const state = getSessionState(config.MY_TELEGRAM_ID);
      this.lastProactiveCheckHour = state.lastProactiveCheckHour ?? null;
      console.log(`[BrainLoop] State restored`);
    } catch (err) {
      console.warn("[BrainLoop] State restore failed:", err);
    }
  }

  private persistState(): void {
    try {
      updateSessionState(config.MY_TELEGRAM_ID, {
        lastProactiveCheckHour: this.lastProactiveCheckHour,
      });
    } catch (err) {
      console.warn("[BrainLoop] State persist failed:", err);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

export const brainLoop = new BrainLoop();

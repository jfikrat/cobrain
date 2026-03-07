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
import { handleTopicMessage, getTopicRoute } from "../channels/telegram-router.ts";
import { mneme } from "../mneme/mneme.ts";
import { inbox } from "./inbox.ts";
import { readLoopConfig, type LoopConfig, DEFAULT_LOOP_CONFIG } from "../agent/tools/agent-loop.ts";
import { DAY_NAMES, ACTIVE_HOUR_START, ACTIVE_HOUR_END, REMINDER_INBOX_TTL_MS, EXPECTATION_INBOX_TTL_MS, PROACTIVE_INBOX_TTL_MS } from "../constants.ts";

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
            subject: `[reminder] ${reminder.title}`,
            body: `[AUTONOMOUS EVENT — Reminder]\n${reminder.title}${reminder.message ? `\n${reminder.message}` : ""}`,
            priority: "urgent",
            ttlMs: REMINDER_INBOX_TTL_MS,
          });
          console.log(`[BrainLoop] Reminder → Inbox: ${reminder.title}`);
        } catch (err) {
          console.error("[BrainLoop] reminder error:", err);
          if (this.bot) await sendRawLog(this.bot, `❌ <b>Reminder error</b> — ${escapeHtml(reminder.title)}\n<code>${String(err).slice(0, 200)}</code>`);
        }
        // Mark as sent regardless of success/error (prevents infinite loop)
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
        subject: `[expectation_timeout] ${exp.type} — ${exp.target}`,
        body: `Expectation timed out:\nType: ${exp.type}\nTarget: ${exp.target}\nContext: ${exp.context || "none"}\nOnResolved: ${exp.onResolved || "none"}`,
        priority: "normal",
        ttlMs: EXPECTATION_INBOX_TTL_MS,
      });
      console.log(`[BrainLoop] Expectation timeout → Inbox: [${exp.type}] ${exp.target}`);
    }
  }

  // ── Proactive Behaviors Check ─────────────────────────────────────────
  //
  // Once per hour during active hours (07-23), sends Cortex a "check your
  // behaviors.md" message. Which behavior runs when is fully defined in
  // behaviors.md — this code is only the trigger, no behavior is hardcoded.

  private async checkProactiveBehaviors(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // Only during active hours (07:00-23:00)
    if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return;

    // Once per hour
    const hourKey = `${now.toISOString().slice(0, 10)}-${String(hour).padStart(2, "0")}`;
    if (this.lastProactiveCheckHour === hourKey) return;

    this.lastProactiveCheckHour = hourKey;

    const dayName = DAY_NAMES[now.getDay()];
    const timeStr = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = now.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

    await inbox.push({
      from: "scheduler",
      subject: `Proactive check — ${timeStr}`,
      body: `Time: ${timeStr} (${dayName}, ${dateStr})\n\nRead your behaviors.md. Is there anything proactive you should do right now?\n\nYes → do it and notify via Telegram if needed.\nNo → stay silent, mark this message as handled.`,
      priority: "normal",
      ttlMs: PROACTIVE_INBOX_TTL_MS, // Expires in 55min — next tick brings a new one
    });

    console.log(`[BrainLoop] Proactive check pushed: ${hourKey}`);
  }

  // ── Agent Loop System ──────────────────────────────────────────────
  //
  // Her fastTick'te çalışır. Agent'ların loop.json dosyasını okuyup
  // dinamik olarak heartbeat gönderir. Precondition registry ile
  // lightweight check yapabilir.

  private static readonly LOOP_CACHE_TTL_MS = 30_000; // 30s cache

  private static readonly PRECONDITIONS: Record<string, () => boolean> = {};

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

    // Only during active hours (07:00-23:00)
    if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return;

    const { listActiveAgents } = await import("../agents/registry.ts");
    const agents = listActiveAgents();
    if (agents.length === 0) return;

    for (const agent of agents) {
      try {
        const loopConfig = await this.getLoopConfig(agent.id);

        // Clear expired override
        if (loopConfig.activeUntil && loopConfig.activeUntil < now) {
          loopConfig.activeIntervalMs = null;
          loopConfig.activeUntil = null;
          loopConfig.reason = null;
          // Update cache only (file write is expensive)
          this.agentLoopCache.set(agent.id, { config: loopConfig, loadedAt: Date.now() });
        }

        // Calculate effective interval
        const effectiveInterval = (loopConfig.activeUntil && loopConfig.activeUntil > now && loopConfig.activeIntervalMs)
          ? loopConfig.activeIntervalMs
          : loopConfig.intervalMs;

        // Has enough time passed since last trigger?
        const lastTriggered = this.agentLastTriggered.get(agent.id) ?? 0;
        if (now - lastTriggered < effectiveInterval) continue;

        // Check precondition if defined
        if (loopConfig.precondition) {
          const check = BrainLoop.PRECONDITIONS[loopConfig.precondition];
          if (check && !check()) continue;
        }

        // Heartbeat — run directly via chat() in the agent's session
        const nowDate = new Date();
        const dayName = DAY_NAMES[nowDate.getDay()];
        const timeStr = `${String(nowDate.getHours()).padStart(2, "0")}:${String(nowDate.getMinutes()).padStart(2, "0")}`;
        const dateStr = nowDate.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

        const heartbeatPrompt = `[HEARTBEAT]\nTime: ${timeStr} (${dayName}, ${dateStr})\n\nRead your behaviors.md. Is there anything proactive you should do right now?\nYes → do it. No → stay silent.`;

        const topicRoute = getTopicRoute(agent.topicId);
        if (!topicRoute) continue;

        // Log heartbeat to channel (for visual tracking)
        if (config.LOG_CHANNEL_ID) {
          this.bot.api.sendMessage(config.LOG_CHANNEL_ID, `⏱ ${agent.id} heartbeat @ ${timeStr}`).catch(() => {});
        }

        // Run in agent's session
        handleTopicMessage(
          config.MY_TELEGRAM_ID,
          config.COBRAIN_HUB_ID!,
          agent.topicId,
          topicRoute,
          heartbeatPrompt,
        ).then(async (response) => {
          // Write response to topic
          if (response && response.trim() && this.bot) {
            await this.bot.api.sendMessage(config.COBRAIN_HUB_ID!, response, {
              message_thread_id: agent.topicId,
            }).catch(() => {});
          }
        }).catch((err) => {
          console.warn(`[BrainLoop] Agent heartbeat response failed for ${agent.id}:`, err);
        });

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

    // Wait if user is in conversation
    if (isUserBusy(config.MY_TELEGRAM_ID)) return;

    const prompt = [
      `[INBOX — ${pendingItem.from.toUpperCase()}]`,
      `Subject: ${pendingItem.subject}`,
      ``,
      pendingItem.body,
    ].join("\n");

    console.log(`[BrainLoop] Processing inbox item: "${pendingItem.subject}"`);

    // Show "typing" indicator — refresh every 4s
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
        console.error("[BrainLoop] Inbox processing error:", err);
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

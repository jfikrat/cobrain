/**
 * BrainLoop — Unified autonomous loop
 * Replaces: living-assistant.ts + cortex/heartbeat.ts + autonomous-loop.ts
 *
 * Architecture:
 * - fastTick (30s): WhatsApp poll + due reminders + cooldown cleanup (no AI)
 * - slowTick (5min): context gathering + knowledge + Gemini Flash reasoning + actions
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Bot } from "grammy";
import { config } from "../config.ts";
import { userManager } from "./user-manager.ts";
import { getGoalsService } from "./goals.ts";
import { getMoodTrackingService, type MoodType } from "./mood-tracking.ts";
import { getActivityPatternService } from "./activity-patterns.ts";
import { SmartMemory, type FollowupCandidate } from "../memory/smart-memory.ts";
import { getSessionState, updateSessionState } from "./session-state.ts";
import { signalBus } from "../cortex/signal-bus.ts";
import { actionExecutor } from "../cortex/actions.ts";
import { expectations } from "../cortex/expectations.ts";
import { heartbeat } from "./heartbeat.ts";
import { whatsappDB } from "./whatsapp-db.ts";
import { getTaskQueue } from "./task-queue.ts";
import { withTimeout, geminiBreaker } from "../cortex/utils.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import { handleDMMessages, handleWatchedGroupMessages } from "./proactive.ts";
import type { ActionPlan, ActionType } from "../cortex/reasoner.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface ContextData {
  time: {
    hour: number;
    dayOfWeek: number;
    dayName: string;
    timeOfDay: "morning" | "afternoon" | "evening" | "night";
    isWeekend: boolean;
  };
  goals: {
    active: number;
    approaching: Array<{ id: number; title: string; dueDate: string; daysLeft: number }>;
    needingFollowup: Array<{ id: number; title: string; progress: number; daysSinceFollowup: number }>;
  };
  reminders: {
    pending: number;
    upcoming: Array<{ title: string; triggerAt: string; minutesLeft: number }>;
    overdue: Array<{ title: string; triggerAt: string }>;
  };
  lastInteraction: {
    minutesAgo: number;
    wasRecent: boolean;
  };
  mood: {
    current: MoodType | null;
    trend: "improving" | "stable" | "declining";
    averageEnergy: number;
  };
  patterns: {
    isOptimalTime: boolean;
    currentSlotScore: number;
  };
  memoryFollowups: FollowupCandidate[];
  expectations: Array<{ type: string; target: string; context: string }>;
}

/** Result shape from handleDMMessages / handleWatchedGroupMessages */
interface WhatsAppResult {
  tier?: number;
  outboxSuccess?: boolean;
  model: string;
  error?: string;
}

// ── Cooldown Manager ─────────────────────────────────────────────────────

const COOLDOWN_DEFAULTS: Record<string, number> = {
  morning_briefing: 23 * 60 * 60 * 1000,
  evening_summary: 23 * 60 * 60 * 1000,
  goal_nudge: 47 * 60 * 60 * 1000,
  mood_check: 4 * 60 * 60 * 1000,
  memory_digest: 6 * 24 * 60 * 60 * 1000,
  inactivity_nudge: 3 * 60 * 60 * 1000,
  goal_followup: 24 * 60 * 60 * 1000,
  code_review: 23 * 60 * 60 * 1000,
  general_notification: 5 * 60 * 1000,
};

class CooldownManager {
  private cooldowns = new Map<string, number>();

  isExpired(key: string): boolean {
    const last = this.cooldowns.get(key);
    if (!last) return true;
    // Use the registered TTL, or extract base key for lookup
    const baseKey = key.includes(":") ? key.split(":")[0]! : key;
    const ttl = COOLDOWN_DEFAULTS[key] ?? COOLDOWN_DEFAULTS[baseKey] ?? COOLDOWN_DEFAULTS.general_notification!;
    return Date.now() - last >= ttl;
  }

  set(key: string): void {
    this.cooldowns.set(key, Date.now());
  }

  restore(cooldowns: Record<string, { lastSent: number; type: string }>): void {
    for (const [key, entry] of Object.entries(cooldowns)) {
      this.cooldowns.set(key, entry.lastSent);
    }
  }

  serialize(): Record<string, { lastSent: number; type: string }> {
    const result: Record<string, { lastSent: number; type: string }> = {};
    for (const [key, timestamp] of this.cooldowns) {
      result[key] = { lastSent: timestamp, type: key };
    }
    return result;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.cooldowns) {
      const baseKey = key.includes(":") ? key.split(":")[0]! : key;
      const ttl = COOLDOWN_DEFAULTS[key] ?? COOLDOWN_DEFAULTS[baseKey] ?? COOLDOWN_DEFAULTS.general_notification!;
      if (now - timestamp > ttl * 2) {
        this.cooldowns.delete(key);
      }
    }
  }

  get size(): number {
    return this.cooldowns.size;
  }
}

// ── Constants ────────────────────────────────────────────────────────────

const QUIET_HOURS = { start: 23, end: 8 };
const FAST_TICK_MS = 30_000;     // 30 seconds
const SLOW_TICK_MS = 300_000;    // 5 minutes
const KNOWLEDGE_DIR = "knowledge";
const KNOWLEDGE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

const CODE_REVIEW_FILES = [
  "src/agent/chat.ts",
  "src/services/brain-loop.ts",
  "src/brain/index.ts",
  "src/memory/smart-memory.ts",
  "src/services/proactive.ts",
  "src/channels/telegram.ts",
  "src/services/whatsapp.ts",
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

// ── Knowledge Cache ──────────────────────────────────────────────────────

let knowledgeCache: { content: string; loadedAt: number } | null = null;

function getKnowledge(): string {
  const now = Date.now();
  if (knowledgeCache && now - knowledgeCache.loadedAt < KNOWLEDGE_TTL_MS) {
    return knowledgeCache.content;
  }

  const knowledgePath = resolve(config.COBRAIN_BASE_PATH, KNOWLEDGE_DIR);

  try {
    if (!existsSync(knowledgePath)) {
      knowledgeCache = { content: "", loadedAt: now };
      return "";
    }

    const files = readdirSync(knowledgePath).filter(f => f.endsWith(".md"));
    const parts: string[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(knowledgePath, file), "utf-8");
        parts.push(`## ${file.replace(".md", "")}\n${content.trim()}`);
      } catch {
        // Skip unreadable files
      }
    }

    const combined = parts.join("\n\n");
    knowledgeCache = { content: combined, loadedAt: now };
    return combined;
  } catch (err) {
    console.warn("[BrainLoop] Knowledge load failed:", err);
    knowledgeCache = { content: "", loadedAt: now };
    return "";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
}

function getTimeOfDay(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

// ── BrainLoop Class ──────────────────────────────────────────────────────

class BrainLoop {
  private bot: Bot | null = null;
  private fastIntervalId: ReturnType<typeof setInterval> | null = null;
  private slowIntervalId: ReturnType<typeof setInterval> | null = null;
  private cooldowns = new CooldownManager();
  private geminiModel;
  private codeReviewIndex = 0;
  private lastCodeReviewDate: string | null = null;

  constructor() {
    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    this.geminiModel = genAI.getGenerativeModel({ model: config.CORTEX_MODEL });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(botInstance: Bot): void {
    this.bot = botInstance;
    this.restoreState();

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
    this.persistState();
    console.log("[BrainLoop] Stopped");
  }

  // ── Fast Tick (30s, no AI) ─────────────────────────────────────────

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

    this.cooldowns.cleanup();
  }

  // ── Slow Tick (5min, with AI) ──────────────────────────────────────

  private async slowTick(): Promise<void> {
    heartbeat("brain_loop", { event: "slow_tick" });
    const userId = config.MY_TELEGRAM_ID;

    // 1. Gather context
    let ctx: ContextData;
    try {
      ctx = await this.gatherContext(userId);
    } catch (err) {
      console.error("[BrainLoop] gatherContext error:", err);
      return;
    }

    // 2. Quick rule-based decisions (no AI)
    const quickActions = this.quickDecisions(ctx);
    for (const plan of quickActions) {
      try {
        await actionExecutor.execute(plan);
        if (plan.action !== "none") this.cooldowns.set(plan.action);
      } catch (err) {
        console.error(`[BrainLoop] Quick action ${plan.action} failed:`, err);
      }
    }

    // 3. AI reasoning (Gemini Flash)
    try {
      const plan = await this.aiReason(ctx);
      if (plan.action !== "none") {
        await actionExecutor.execute(plan);
        this.cooldowns.set(plan.action);
      }
    } catch (err) {
      console.error("[BrainLoop] aiReason error:", err);
    }

    // 4. Code review cycle
    try {
      await this.maybeRunCodeReview(userId);
    } catch (err) {
      console.error("[BrainLoop] maybeRunCodeReview error:", err);
    }

    // 5. Persist state
    this.persistState();
  }

  // ── WhatsApp Polling ───────────────────────────────────────────────

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

    // ── Process DMs ──────────────────────────────────────────────────
    if (dms.length > 0) {
      const bySender = new Map<string, typeof dms>();
      for (const notif of dms) {
        const key = notif.chat_jid;
        if (!bySender.has(key)) bySender.set(key, []);
        bySender.get(key)!.push(notif);
      }

      for (const [chatJid, msgs] of bySender) {
        try {
          const result: WhatsAppResult = await handleDMMessages(msgs, chatJid, userId, config.WHATSAPP_MAX_REPLY_LENGTH);
          const chatIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(chatIds);
          for (const id of chatIds) processedIds.add(id);

          // Push to Cortex Signal Bus if proactive did NOT auto-reply
          const proactiveReplied = result.tier === 1 && result.outboxSuccess === true;
          if (!proactiveReplied && signalBus.isRunning()) {
            const senderName = msgs[0]?.sender_name || chatJid.split("@")[0] || "unknown";
            let conversationHistory: string[] = [];
            try {
              const recentMsgs = whatsappDB.getMessages(chatJid, 10);
              conversationHistory = recentMsgs.map(m => {
                const who = m.is_from_me ? "Ben" : senderName;
                const typeTag = m.message_type !== "text" ? `[${m.message_type}] ` : "";
                return `${who}: ${typeTag}${(m.content || "").slice(0, 150)}`;
              });
            } catch { /* WhatsApp DB unavailable */ }

            signalBus.push("whatsapp_message", "dm", {
              chatJid,
              senderName,
              messageCount: msgs.length,
              preview: msgs.map(m => m.content?.slice(0, 100)).filter(Boolean).join(" | "),
              conversationHistory,
            }, { userId, contactId: chatJid });
          }
        } catch (chatError) {
          console.error(`[BrainLoop] DM chat ${chatJid} error:`, chatError);
        }
      }
    }

    // ── Process Group Messages ───────────────────────────────────────
    if (groupMsgs.length > 0) {
      const byGroup = new Map<string, typeof groupMsgs>();
      for (const notif of groupMsgs) {
        const key = notif.chat_jid;
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(notif);
      }

      for (const [groupJid, msgs] of byGroup) {
        try {
          const replyAllowed = allowedGroupJids.length > 0 && allowedGroupJids.includes(groupJid);
          await handleWatchedGroupMessages(msgs, userId, replyAllowed, config.WHATSAPP_MAX_REPLY_LENGTH);
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

  // ── Due Reminders ──────────────────────────────────────────────────

  private async checkDueReminders(): Promise<void> {
    const userId = config.MY_TELEGRAM_ID;
    const taskQueue = getTaskQueue();

    try {
      const db = await userManager.getUserDb(userId);
      const goalsService = await getGoalsService(db, userId);
      const dueReminders = goalsService.getDueReminders();

      for (const reminder of dueReminders) {
        taskQueue.enqueue(
          userId,
          "reminder",
          { reminderId: reminder.id, title: reminder.title, message: reminder.message },
          5,
          `reminder:${reminder.id}`
        );
      }
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }
  }

  // ── Context Gathering ──────────────────────────────────────────────

  private async gatherContext(userId: number): Promise<ContextData> {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    const dayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

    const ctx: ContextData = {
      time: {
        hour,
        dayOfWeek,
        dayName: dayNames[dayOfWeek]!,
        timeOfDay: getTimeOfDay(hour),
        isWeekend: [0, 6].includes(dayOfWeek),
      },
      goals: { active: 0, approaching: [], needingFollowup: [] },
      reminders: { pending: 0, upcoming: [], overdue: [] },
      lastInteraction: { minutesAgo: -1, wasRecent: false },
      mood: { current: null, trend: "stable", averageEnergy: 3 },
      patterns: { isOptimalTime: false, currentSlotScore: 0 },
      memoryFollowups: [],
      expectations: [],
    };

    // Goals & reminders
    try {
      const db = await userManager.getUserDb(userId);
      const goalsService = await getGoalsService(db, userId);
      const activeGoals = goalsService.getActiveGoals();
      const pendingReminders = goalsService.getPendingReminders();

      ctx.goals.active = activeGoals.length;
      ctx.goals.approaching = activeGoals
        .filter(g => g.dueDate)
        .map(g => {
          const dueDate = new Date(g.dueDate!);
          const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          return { id: g.id, title: g.title, dueDate: g.dueDate!, daysLeft };
        })
        .filter(g => g.daysLeft >= 0 && g.daysLeft <= 3)
        .sort((a, b) => a.daysLeft - b.daysLeft);

      ctx.goals.needingFollowup = goalsService.getGoalsNeedingFollowup()
        .filter(g => this.cooldowns.isExpired(`goal_${g.id}`))
        .map(g => ({
          id: g.id,
          title: g.title,
          progress: Math.round(g.progress * 100),
          daysSinceFollowup: goalsService.getDaysSinceFollowup(g.id) ?? 0,
        }));

      ctx.reminders.pending = pendingReminders.length;
      ctx.reminders.upcoming = pendingReminders
        .map(r => {
          const triggerAt = new Date(r.triggerAt);
          const minutesLeft = Math.ceil((triggerAt.getTime() - now.getTime()) / (1000 * 60));
          return { title: r.title, triggerAt: r.triggerAt, minutesLeft };
        })
        .filter(r => r.minutesLeft > 0 && r.minutesLeft <= 30)
        .sort((a, b) => a.minutesLeft - b.minutesLeft);

      ctx.reminders.overdue = pendingReminders
        .filter(r => new Date(r.triggerAt) < now)
        .map(r => ({ title: r.title, triggerAt: r.triggerAt }));
    } catch (err) {
      console.warn("[BrainLoop] Goals/reminders context failed:", err);
    }

    // Last interaction (from session state)
    try {
      const state = getSessionState(userId);
      const minutesAgo = state.lastInteractionTime > 0
        ? Math.floor((Date.now() - state.lastInteractionTime) / (1000 * 60))
        : -1;
      ctx.lastInteraction = { minutesAgo, wasRecent: minutesAgo >= 0 && minutesAgo < 30 };
    } catch (err) {
      console.warn("[BrainLoop] Last interaction context failed:", err);
    }

    // Mood
    try {
      const moodService = await getMoodTrackingService(userId);
      const currentMood = moodService.getCurrentMood();
      const moodTrend = moodService.getMoodTrend(7);
      ctx.mood = {
        current: currentMood?.mood ?? null,
        trend: moodTrend.direction,
        averageEnergy: moodTrend.averageEnergy,
      };
    } catch (err) {
      console.warn("[BrainLoop] Mood context failed:", err);
    }

    // Activity patterns
    try {
      const patternService = await getActivityPatternService(userId);
      ctx.patterns = {
        isOptimalTime: patternService.shouldNotifyNow(),
        currentSlotScore: patternService.getCurrentSlotScore(),
      };
    } catch (err) {
      console.warn("[BrainLoop] Patterns context failed:", err);
    }

    // Memory follow-ups
    if (this.cooldowns.isExpired("memory_digest")) {
      let memory: SmartMemory | null = null;
      try {
        const userFolder = userManager.getUserFolder(userId);
        memory = new SmartMemory(userFolder, userId);
        ctx.memoryFollowups = memory.findFollowupOpportunities(14);
      } catch (err) {
        console.warn("[BrainLoop] Memory followup context failed:", err);
      } finally {
        try { memory?.close(); } catch { /* ignore close errors */ }
      }
    }

    // Pending expectations
    try {
      ctx.expectations = expectations.pending().map(e => ({
        type: e.type,
        target: e.target || "",
        context: e.context || "",
      }));
    } catch (err) {
      console.warn("[BrainLoop] Expectations context failed:", err);
    }

    return ctx;
  }

  // ── Quick Decisions (rule-based, no AI) ────────────────────────────

  private quickDecisions(ctx: ContextData): ActionPlan[] {
    const plans: ActionPlan[] = [];
    const quiet = isQuietHours();

    // Overdue reminders
    for (const overdue of ctx.reminders.overdue) {
      const overdueMs = Date.now() - new Date(overdue.triggerAt).getTime();
      const isUrgent = overdueMs > 24 * 60 * 60 * 1000;
      if (quiet && !isUrgent) continue;

      const key = `overdue:${overdue.title}`;
      if (!this.cooldowns.isExpired(key)) continue;
      this.cooldowns.set(key);

      plans.push({
        action: "send_message",
        params: { text: `⏰ Kaçırdığın hatırlatıcı: "${overdue.title}"` },
        reasoning: "overdue_reminder",
        urgency: "immediate",
      });
      break; // One at a time
    }

    // Approaching reminders (within 5 min)
    if (!quiet && plans.length === 0) {
      for (const reminder of ctx.reminders.upcoming) {
        if (reminder.minutesLeft > 5) continue;
        const key = `upcoming:${reminder.title}`;
        if (!this.cooldowns.isExpired(key)) continue;
        this.cooldowns.set(key);

        plans.push({
          action: "send_message",
          params: { text: `⏰ ${reminder.minutesLeft} dakika içinde: "${reminder.title}"` },
          reasoning: "imminent_reminder",
          urgency: "immediate",
        });
        break;
      }
    }

    // Goal deadline today
    if (!quiet && plans.length === 0) {
      const todayDeadline = ctx.goals.approaching.find(g => g.daysLeft === 0);
      if (todayDeadline && this.cooldowns.isExpired(`goal_${todayDeadline.id}`)) {
        this.cooldowns.set(`goal_${todayDeadline.id}`);
        plans.push({
          action: "goal_nudge",
          params: { message: `🎯 Bugün deadline: "${todayDeadline.title}"` },
          reasoning: "today_deadline",
          urgency: "immediate",
        });
      }
    }

    return plans;
  }

  // ── AI Reasoning (Gemini Flash) ────────────────────────────────────

  private async aiReason(ctx: ContextData): Promise<ActionPlan> {
    const noAction: ActionPlan = { action: "none", params: {}, reasoning: "", urgency: "background" };

    if (!config.GEMINI_API_KEY) {
      noAction.reasoning = "no_gemini_key";
      return noAction;
    }

    // Don't disturb at night
    if (ctx.time.timeOfDay === "night" && ctx.time.hour >= 23) {
      noAction.reasoning = "quiet_hours";
      return noAction;
    }

    // Don't disturb if recently active
    if (ctx.lastInteraction.wasRecent) {
      noAction.reasoning = "recently_active";
      return noAction;
    }

    const knowledge = getKnowledge();
    const prompt = this.buildAIPrompt(ctx, knowledge);

    try {
      const result = await geminiBreaker.execute(() =>
        withTimeout(
          this.geminiModel.generateContent(prompt),
          config.CORTEX_AI_TIMEOUT_MS,
          "BrainLoop AI reasoning",
        ),
      );
      const text = result.response.text().trim();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: "none", params: {}, reasoning: "no_json_in_response", urgency: "background" };
      }

      const raw = JSON.parse(jsonMatch[0]);

      const VALID_ACTIONS: ActionType[] = [
        "send_message", "send_whatsapp", "calculate_route", "remember",
        "create_expectation", "resolve_expectation", "check_whatsapp",
        "morning_briefing", "evening_summary", "goal_nudge",
        "mood_check", "memory_digest", "think_and_note",
        "compound", "none",
      ];
      const VALID_URGENCIES: ActionPlan["urgency"][] = ["immediate", "soon", "background"];

      if (!VALID_ACTIONS.includes(raw.action)) {
        console.warn(`[BrainLoop] Invalid AI action "${raw.action}", defaulting to none`);
        return { action: "none", params: {}, reasoning: `invalid_action: ${raw.action}`, urgency: "background" };
      }

      const plan: ActionPlan = {
        action: raw.action as ActionType,
        params: raw.params && typeof raw.params === "object" ? raw.params : {},
        reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "No reasoning",
        urgency: VALID_URGENCIES.includes(raw.urgency) ? raw.urgency : "background",
        ...(raw.followUp ? { followUp: raw.followUp } : {}),
      };

      console.log(`[BrainLoop] AI decision: action=${plan.action} urgency=${plan.urgency} "${plan.reasoning}"`);
      return plan;
    } catch (err) {
      console.warn("[BrainLoop] AI reasoning failed:", err);
      return { action: "none", params: {}, reasoning: "ai_error", urgency: "background" };
    }
  }

  // ── AI Prompt Builder ──────────────────────────────────────────────

  private buildAIPrompt(ctx: ContextData, knowledge: string): string {
    const moodLabels: Record<string, string> = {
      great: "harika", good: "iyi", neutral: "normal", low: "düşük", bad: "kötü",
    };

    const contextSummary = `Şu an: ${ctx.time.dayName}, saat ${ctx.time.hour}:00 (${ctx.time.timeOfDay})
Hafta sonu: ${ctx.time.isWeekend ? "evet" : "hayır"}
Son etkileşim: ${ctx.lastInteraction.minutesAgo >= 0 ? `${ctx.lastInteraction.minutesAgo} dakika önce` : "bilinmiyor"}
Aktif hedef: ${ctx.goals.active}
Yaklaşan deadline: ${ctx.goals.approaching.map(g => `"${g.title}" (${g.daysLeft} gün)`).join(", ") || "yok"}
Takip bekleyen: ${ctx.goals.needingFollowup.map(g => `"${g.title}" (%${g.progress}, ${g.daysSinceFollowup} gün)`).join(", ") || "yok"}
Bekleyen hatırlatıcı: ${ctx.reminders.pending}
Yaklaşan (30dk): ${ctx.reminders.upcoming.map(r => `"${r.title}" (${r.minutesLeft}dk)`).join(", ") || "yok"}
Ruh hali: ${ctx.mood.current ? moodLabels[ctx.mood.current] || ctx.mood.current : "bilinmiyor"} (trend: ${ctx.mood.trend}, enerji: ${ctx.mood.averageEnergy.toFixed(1)}/5)
Optimal zaman: ${ctx.patterns.isOptimalTime ? "evet" : "hayır"} (skor: ${(ctx.patterns.currentSlotScore * 100).toFixed(0)}%)
Hafıza takip: ${ctx.memoryFollowups.slice(0, 2).map(m => `"${m.topic.slice(0, 50)}" (${m.daysSince}g)`).join(", ") || "yok"}
Beklentiler: ${ctx.expectations.slice(0, 3).map(e => `[${e.type}] ${e.target}: ${e.context.slice(0, 50)}`).join(" | ") || "yok"}`.trim();

    const knowledgeBlock = knowledge
      ? `\nBİLGİ TABANI (kişiler, lokasyonlar, rutinler, otomatik cevaplar):\n${knowledge.slice(0, 2000)}`
      : "";

    return `Sen Cobrain AI asistanının otonom karar mekanizmasısın. Periyodik olarak kullanıcının durumunu değerlendiriyorsun.

BAĞLAM:
${contextSummary}
${knowledgeBlock}

MEVCUT AKSİYONLAR:
- send_message: Telegram'dan kullanıcıya bildir. Params: {text: "mesaj"}
- morning_briefing: Sabah özeti. Params: {message: "özet"}
- evening_summary: Akşam özeti. Params: {message: "özet"}
- goal_nudge: Hedef hatırlatması. Params: {message: "mesaj"}
- mood_check: Ruh hali kontrolü. Params: {message: "mesaj"}
- memory_digest: Hafıza özeti. Params: {message: "özet"}
- remember: Hafızaya kaydet. Params: {content: "...", importance?: 0-1}
- think_and_note: Sessiz not. Params: {content: "not"}
- none: Aksiyon gerekmiyor

KURALLAR:
1. Gereksiz bildirim GÖNDERME. Çoğu zaman "none" doğru cevaptır.
2. Sabah (8-10) kısa özet, akşam (20-22) günü değerlendirme uygun olabilir.
3. Hedef takibi için samimi ama kısa ol.
4. Mood düşükse nazik ol, zorlama.
5. Optimal zaman değilse priority düşür.
6. Kısa, doğal, samimi mesajlar yaz — makine gibi özet değil, arkadaş gibi check-in.

SADECE JSON döndür:
{"action": "...", "params": {...}, "reasoning": "kısa açıklama", "urgency": "immediate|soon|background"}`;
  }

  // ── Code Review Cycle ──────────────────────────────────────────────

  private async maybeRunCodeReview(userId: number): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().slice(0, 10);

    if (hour !== 14) return;
    if (this.lastCodeReviewDate === today) return;
    if (!this.cooldowns.isExpired("code_review")) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const filePath = CODE_REVIEW_FILES[this.codeReviewIndex % CODE_REVIEW_FILES.length]!;
    this.codeReviewIndex++;
    this.lastCodeReviewDate = today;
    this.cooldowns.set("code_review");

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
          `🐛 Code review'da yüksek öncelikli bug buldum:\n${bugMsg}\n\nDetay: recall("code-obs") ile bakabilirsin.`
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
      this.cooldowns.restore(state.cooldowns);
      console.log(`[BrainLoop] State restored: codeReviewIdx=${this.codeReviewIndex}, cooldowns=${this.cooldowns.size}`);
    } catch (err) {
      console.warn("[BrainLoop] State restore failed:", err);
    }
  }

  private persistState(): void {
    try {
      updateSessionState(config.MY_TELEGRAM_ID, {
        codeReviewIndex: this.codeReviewIndex,
        lastCodeReviewDate: this.lastCodeReviewDate,
        cooldowns: this.cooldowns.serialize(),
      });
    } catch (err) {
      console.warn("[BrainLoop] State persist failed:", err);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

export const brainLoop = new BrainLoop();

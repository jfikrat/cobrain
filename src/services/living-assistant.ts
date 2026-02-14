/**
 * Living Assistant - AI-powered proactive awareness
 * Uses Haiku for cheap, fast context analysis
 * Cobrain v0.7 - Level 3 Proactive System
 */

import { Bot } from "grammy";
import { userManager } from "./user-manager.ts";
import { getGoalsService } from "./goals.ts";
import { getMoodTrackingService, type MoodType } from "./mood-tracking.ts";
import { getActivityPatternService } from "./activity-patterns.ts";
import { SmartMemory, type FollowupCandidate } from "../memory/smart-memory.ts";
import { config } from "../config.ts";
import { heartbeat } from "./heartbeat.ts";
import { getSessionState, updateSessionState } from "./session-state.ts";
import { signalBus } from "../cortex/signal-bus.ts";

// Haiku API for cheap analysis
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20250121";

interface ContextData {
  time: {
    hour: number;
    dayOfWeek: number;
    dayName: string;
    timeOfDay: "morning" | "afternoon" | "evening" | "night";
  };
  goals: {
    active: number;
    approaching: Array<{ title: string; dueDate: string; daysLeft: number }>;
    needingFollowup: Array<{ id: number; title: string; daysSinceFollowup: number }>;
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
}

interface ProactiveDecision {
  shouldNotify: boolean;
  priority: "low" | "medium" | "high" | "urgent";
  type: "summary" | "goal_followup" | "memory_followup" | "nudge" | "mood_check" | "none";
  message: string | null;
  reason: string;
}

// Code review cycle — rotate list of core files
const CODE_REVIEW_FILES = [
  "src/agent/chat.ts",
  "src/services/living-assistant.ts",
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

let lastCodeReviewDate: string | null = null;
let codeReviewIndex = 0;
let lastTimeTickPush = 0;

// Cooldown tracking
interface CooldownEntry {
  lastSent: number;
  type: string;
  targetId?: number; // For goal-specific cooldowns
}

let bot: Bot | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let lastNotificationTime = new Map<number, number>();
let lastInteractionTime = new Map<number, number>();
const cooldowns = new Map<string, CooldownEntry>();

// Minimum time between proactive notifications (5 minutes)
const MIN_NOTIFICATION_INTERVAL = 5 * 60 * 1000;

// Per-reminder notification cooldown tracking (reminderKey → lastNotifiedTimestamp)
const reminderCooldowns = new Map<string, number>();

// Per-reminder cooldown durations
const REMINDER_COOLDOWN_MS = {
  overdue: 4 * 60 * 60 * 1000,   // 4 hours for overdue reminders
  upcoming: 1 * 60 * 60 * 1000,  // 1 hour for upcoming reminders
};

// Quiet hours: 23:00 - 08:00 (only urgent notifications pass)
const QUIET_HOURS = { start: 23, end: 8 };

// Cleanup interval for expired reminder cooldowns (every 30 minutes)
const REMINDER_COOLDOWN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
let lastReminderCooldownCleanup = 0;

// Cooldown rules (in milliseconds)
const COOLDOWN_RULES = {
  goal_followup: 24 * 60 * 60 * 1000, // 24 hours per goal
  memory_followup: 72 * 60 * 60 * 1000, // 72 hours
  morning_summary: 24 * 60 * 60 * 1000, // 24 hours
  evening_reflection: 24 * 60 * 60 * 1000, // 24 hours
  mood_check: 4 * 60 * 60 * 1000, // 4 hours
  nudge: 2 * 60 * 60 * 1000, // 2 hours
};

/**
 * Initialize the living assistant
 */
export function initLivingAssistant(botInstance: Bot): void {
  bot = botInstance;

  // Restore volatile state from session-state.json
  if (config.FF_SESSION_STATE) {
    try {
      const state = getSessionState(config.MY_TELEGRAM_ID);
      lastCodeReviewDate = state.lastCodeReviewDate;
      codeReviewIndex = state.codeReviewIndex;
      if (state.lastInteractionTime > 0)
        lastInteractionTime.set(config.MY_TELEGRAM_ID, state.lastInteractionTime);
      if (state.lastNotificationTime > 0)
        lastNotificationTime.set(config.MY_TELEGRAM_ID, state.lastNotificationTime);
      for (const [key, entry] of Object.entries(state.cooldowns))
        cooldowns.set(key, entry);
      console.log(`[LivingAssistant] State restored: codeReviewIdx=${codeReviewIndex}, cooldowns=${cooldowns.size}`);
    } catch (err) {
      console.warn(`[LivingAssistant] State restore failed:`, err);
    }
  }

  // Start the awareness loop
  const interval = config.HEARTBEAT_LOG_INTERVAL_MS || 30_000;
  intervalId = setInterval(() => {
    runAwarenessLoop();
  }, interval);

  console.log(`[LivingAssistant] Started (interval: ${interval}ms) - Level 3 Proactive`);
}

/**
 * Stop the living assistant
 */
export function stopLivingAssistant(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log("[LivingAssistant] Stopped");
}

/**
 * Record user interaction (called when user sends a message)
 */
export function recordInteraction(userId: number): void {
  lastInteractionTime.set(userId, Date.now());
  if (config.FF_SESSION_STATE) {
    updateSessionState(userId, { lastInteractionTime: Date.now() });
  }
}

/**
 * Check if a cooldown has expired
 */
function isCooldownExpired(key: string, cooldownMs: number): boolean {
  const entry = cooldowns.get(key);
  if (!entry) return true;
  return Date.now() - entry.lastSent >= cooldownMs;
}

/**
 * Set a cooldown
 */
function setCooldown(key: string, type: string, targetId?: number): void {
  cooldowns.set(key, {
    lastSent: Date.now(),
    type,
    targetId,
  });
}

/**
 * Check if a reminder was already notified within its cooldown window
 */
function isReminderOnCooldown(reminderKey: string, type: "overdue" | "upcoming"): boolean {
  const lastNotified = reminderCooldowns.get(reminderKey);
  if (!lastNotified) return false;
  return Date.now() - lastNotified < REMINDER_COOLDOWN_MS[type];
}

/**
 * Mark a reminder as notified (set its cooldown)
 */
function markReminderNotified(reminderKey: string): void {
  reminderCooldowns.set(reminderKey, Date.now());
}

/**
 * Check if current time is within quiet hours (23:00 - 08:00)
 */
function isQuietHours(): boolean {
  const hour = new Date().getHours();
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
}

/**
 * Check if an overdue reminder is urgent (overdue by more than 24 hours)
 */
function isUrgentOverdue(triggerAt: string): boolean {
  const overdueMs = Date.now() - new Date(triggerAt).getTime();
  return overdueMs > 24 * 60 * 60 * 1000;
}

/**
 * Clean up expired reminder cooldown entries to prevent memory leak
 */
function cleanupReminderCooldowns(): void {
  const now = Date.now();
  if (now - lastReminderCooldownCleanup < REMINDER_COOLDOWN_CLEANUP_INTERVAL_MS) return;
  lastReminderCooldownCleanup = now;

  const maxTtl = Math.max(REMINDER_COOLDOWN_MS.overdue, REMINDER_COOLDOWN_MS.upcoming);
  let cleaned = 0;
  for (const [key, timestamp] of reminderCooldowns) {
    if (now - timestamp > maxTtl) {
      reminderCooldowns.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[LivingAssistant] Cleaned ${cleaned} expired reminder cooldown(s), ${reminderCooldowns.size} remaining`);
  }
}

/**
 * Main awareness loop - runs every 30 seconds
 */
async function runAwarenessLoop(): Promise<void> {
  heartbeat("proactive_service", { event: "awareness_tick" });

  // Periodic cleanup of expired reminder cooldowns
  cleanupReminderCooldowns();

  // Push time_tick signal to Cortex every 5 minutes
  try {
    const now = Date.now();
    if (now - lastTimeTickPush >= 5 * 60 * 1000) {
      lastTimeTickPush = now;
      const d = new Date();
      const lastInteraction = lastInteractionTime.get(config.MY_TELEGRAM_ID) || 0;
      const lastInteractionMinutesAgo = lastInteraction > 0
        ? Math.floor((now - lastInteraction) / (1000 * 60))
        : -1;

      signalBus.push("time_tick", "periodic", {
        hour: d.getHours(),
        minute: d.getMinutes(),
        day: d.toLocaleDateString("tr-TR", { weekday: "long" }),
        isWeekend: [0, 6].includes(d.getDay()),
        lastInteractionMinutesAgo,
      }, { userId: config.MY_TELEGRAM_ID });
    }
  } catch (err) {
    console.warn("[LivingAssistant] time_tick signal failed:", err);
  }

  // Single-user mode: only check the owner
  const userId = config.MY_TELEGRAM_ID;
  try {
    await checkUserContext(userId);
  } catch (error) {
    console.error(`[LivingAssistant] Error:`, error);
  }

  // Code review cycle — once per day, around 14:00-15:00
  try {
    await maybeRunCodeReview(userId);
  } catch (error) {
    console.error(`[LivingAssistant] Code review error:`, error);
  }
}

/**
 * Check context and decide if notification is needed
 */
async function checkUserContext(userId: number): Promise<void> {
  if (!bot) return;

  // Check if we recently sent a notification
  const lastNotif = lastNotificationTime.get(userId) || 0;
  if (Date.now() - lastNotif < MIN_NOTIFICATION_INTERVAL) {
    return; // Too soon for another notification
  }

  // Gather context
  const context = await gatherContext(userId);

  // Quick checks before using AI
  const quickDecision = makeQuickDecision(context);
  if (quickDecision.shouldNotify && quickDecision.message) {
    await sendNotification(userId, quickDecision.message, quickDecision.priority, quickDecision.type);
    return;
  }

  // If nothing urgent, use Haiku for deeper analysis (less frequently)
  // Only do AI analysis every 5 minutes to save costs
  const lastAiCheck = lastNotificationTime.get(userId + 1000000) || 0;
  if (Date.now() - lastAiCheck < 5 * 60 * 1000) {
    return;
  }
  lastNotificationTime.set(userId + 1000000, Date.now());

  // Use Haiku for intelligent analysis
  const aiDecision = await analyzeWithHaiku(context, userId);
  if (aiDecision.shouldNotify && aiDecision.message) {
    await sendNotification(userId, aiDecision.message, aiDecision.priority, aiDecision.type);
  }
}

/**
 * Gather all context data for analysis
 */
async function gatherContext(userId: number): Promise<ContextData> {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const dayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

  // Determine time of day
  let timeOfDay: "morning" | "afternoon" | "evening" | "night";
  if (hour >= 6 && hour < 12) timeOfDay = "morning";
  else if (hour >= 12 && hour < 17) timeOfDay = "afternoon";
  else if (hour >= 17 && hour < 22) timeOfDay = "evening";
  else timeOfDay = "night";

  // Get goals and reminders
  const db = await userManager.getUserDb(userId);
  const goalsService = await getGoalsService(db, userId);

  const activeGoals = goalsService.getActiveGoals();
  const pendingReminders = goalsService.getPendingReminders();

  // Find approaching deadlines (within 3 days)
  const approaching = activeGoals
    .filter((g) => g.dueDate)
    .map((g) => {
      const dueDate = new Date(g.dueDate!);
      const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return { title: g.title, dueDate: g.dueDate!, daysLeft };
    })
    .filter((g) => g.daysLeft >= 0 && g.daysLeft <= 3)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  // Find goals needing follow-up (with cooldown check)
  const goalsNeedingFollowup = goalsService.getGoalsNeedingFollowup()
    .filter((g) => isCooldownExpired(`goal_${g.id}`, COOLDOWN_RULES.goal_followup))
    .map((g) => ({
      id: g.id,
      title: g.title,
      daysSinceFollowup: goalsService.getDaysSinceFollowup(g.id) ?? 0,
    }));

  // Find upcoming reminders (within 30 minutes)
  const upcoming = pendingReminders
    .map((r) => {
      const triggerAt = new Date(r.triggerAt);
      const minutesLeft = Math.ceil((triggerAt.getTime() - now.getTime()) / (1000 * 60));
      return { title: r.title, triggerAt: r.triggerAt, minutesLeft };
    })
    .filter((r) => r.minutesLeft > 0 && r.minutesLeft <= 30)
    .sort((a, b) => a.minutesLeft - b.minutesLeft);

  // Find overdue reminders
  const overdue = pendingReminders
    .filter((r) => new Date(r.triggerAt) < now)
    .map((r) => ({ title: r.title, triggerAt: r.triggerAt }));

  // Last interaction
  const lastInteraction = lastInteractionTime.get(userId) || 0;
  const minutesAgo = Math.floor((Date.now() - lastInteraction) / (1000 * 60));

  // Get mood data
  const moodService = await getMoodTrackingService(userId);
  const currentMood = moodService.getCurrentMood();
  const moodTrend = moodService.getMoodTrend(7);

  // Get activity patterns
  const patternService = await getActivityPatternService(userId);
  const isOptimalTime = patternService.shouldNotifyNow();
  const currentSlotScore = patternService.getCurrentSlotScore();

  // Get memory follow-up opportunities (with cooldown check)
  let memoryFollowups: FollowupCandidate[] = [];
  if (isCooldownExpired("memory_followup", COOLDOWN_RULES.memory_followup)) {
    const userFolder = userManager.getUserFolder(userId);
    const memory = new SmartMemory(userFolder, userId);
    memoryFollowups = memory.findFollowupOpportunities(14); // Last 2 weeks
    memory.close();
  }

  return {
    time: {
      hour,
      dayOfWeek,
      dayName: dayNames[dayOfWeek]!,
      timeOfDay,
    },
    goals: {
      active: activeGoals.length,
      approaching,
      needingFollowup: goalsNeedingFollowup,
    },
    reminders: {
      pending: pendingReminders.length,
      upcoming,
      overdue,
    },
    lastInteraction: {
      minutesAgo,
      wasRecent: minutesAgo < 30,
    },
    mood: {
      current: currentMood?.mood ?? null,
      trend: moodTrend.direction,
      averageEnergy: moodTrend.averageEnergy,
    },
    patterns: {
      isOptimalTime,
      currentSlotScore,
    },
    memoryFollowups,
  };
}

/**
 * Quick rule-based decision (no AI needed)
 */
function makeQuickDecision(context: ContextData): ProactiveDecision {
  const quiet = isQuietHours();

  // Urgent: Overdue reminders (with per-reminder cooldown)
  if (context.reminders.overdue.length > 0) {
    for (const overdue of context.reminders.overdue) {
      const key = `overdue:${overdue.title}:${overdue.triggerAt}`;

      // During quiet hours, only allow urgent overdue (>24h)
      if (quiet && !isUrgentOverdue(overdue.triggerAt)) continue;

      // Skip if this specific reminder was already notified within cooldown
      if (isReminderOnCooldown(key, "overdue")) continue;

      markReminderNotified(key);
      return {
        shouldNotify: true,
        priority: "urgent",
        type: "nudge",
        message: `⏰ Kaçırdığın hatırlatıcı: "${overdue.title}"`,
        reason: "overdue_reminder",
      };
    }
  }

  // High: Reminder in next 5 minutes (with per-reminder cooldown)
  // During quiet hours, skip upcoming reminders entirely
  if (!quiet) {
    for (const reminder of context.reminders.upcoming) {
      if (reminder.minutesLeft > 5) continue;

      const key = `upcoming:${reminder.title}:${reminder.triggerAt}`;
      if (isReminderOnCooldown(key, "upcoming")) continue;

      markReminderNotified(key);
      return {
        shouldNotify: true,
        priority: "high",
        type: "nudge",
        message: `⏰ ${reminder.minutesLeft} dakika içinde: "${reminder.title}"`,
        reason: "imminent_reminder",
      };
    }
  }

  // High: Goal deadline today (skip during quiet hours)
  if (!quiet) {
    const todayDeadline = context.goals.approaching.find((g) => g.daysLeft === 0);
    if (todayDeadline) {
      return {
        shouldNotify: true,
        priority: "high",
        type: "goal_followup",
        message: `🎯 Bugün deadline: "${todayDeadline.title}"`,
        reason: "today_deadline",
      };
    }
  }

  // No urgent action needed
  return {
    shouldNotify: false,
    priority: "low",
    type: "none",
    message: null,
    reason: "no_urgent_action",
  };
}

/**
 * Use Haiku for intelligent context analysis
 */
async function analyzeWithHaiku(context: ContextData, userId: number): Promise<ProactiveDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { shouldNotify: false, priority: "low", type: "none", message: null, reason: "no_api_key" };
  }

  // Don't disturb at night unless urgent
  if (context.time.timeOfDay === "night" && context.time.hour >= 23) {
    return { shouldNotify: false, priority: "low", type: "none", message: null, reason: "night_time" };
  }

  // Don't disturb if user was recently active (last 30 min) unless critical
  if (context.lastInteraction.wasRecent) {
    return { shouldNotify: false, priority: "low", type: "none", message: null, reason: "recently_active" };
  }

  // Build context summary for Haiku
  const goalFollowups = context.goals.needingFollowup
    .slice(0, 3)
    .map((g) => `"${g.title}" (${g.daysSinceFollowup} gündür takip yok)`)
    .join(", ");

  const memoryFollowups = context.memoryFollowups
    .slice(0, 2)
    .map((m) => `"${m.topic.slice(0, 50)}..." (${m.daysSince} gün önce)`)
    .join(", ");

  const moodLabels: Record<string, string> = {
    great: "harika",
    good: "iyi",
    neutral: "normal",
    low: "düşük",
    bad: "kötü",
  };

  const contextSummary = `
Şu an: ${context.time.dayName}, saat ${context.time.hour}:00 (${context.time.timeOfDay})
Aktif hedef sayısı: ${context.goals.active}
Yaklaşan deadline'lar: ${context.goals.approaching.map((g) => `"${g.title}" (${g.daysLeft} gün)`).join(", ") || "yok"}
Bekleyen hatırlatıcı: ${context.reminders.pending}
Yaklaşan hatırlatıcılar (30dk): ${context.reminders.upcoming.map((r) => `"${r.title}" (${r.minutesLeft}dk)`).join(", ") || "yok"}
Son etkileşim: ${context.lastInteraction.minutesAgo} dakika önce

Ruh hali: ${context.mood.current ? moodLabels[context.mood.current] : "bilinmiyor"}
Mood trend: ${context.mood.trend === "improving" ? "iyileşiyor" : context.mood.trend === "declining" ? "düşüyor" : "stabil"}
Ortalama enerji: ${context.mood.averageEnergy.toFixed(1)}/5
Optimal bildirim zamanı mı: ${context.patterns.isOptimalTime ? "evet" : "hayır"} (skor: ${(context.patterns.currentSlotScore * 100).toFixed(0)}%)

Takip bekleyen hedefler: ${goalFollowups || "yok"}
Takip fırsatları (hafıza): ${memoryFollowups || "yok"}
`.trim();

  const systemPrompt = `Sen kişisel bir asistansın. Kullanıcının bağlamını analiz et ve proaktif bir bildirim gerekip gerekmediğine karar ver.

Bildirim tipleri:
- summary: Günlük özet (sabah 9-10 veya akşam 20-21)
- goal_followup: Hedef takibi ("Go öğrenme nasıl gidiyor?" gibi)
- memory_followup: Geçmiş konulara geri dönüş
- mood_check: Ruh hali kontrolü (mood düşükse nazik soru)
- nudge: Genel hatırlatma/motivasyon
- none: Bildirim gönderme

Kurallar:
- Gereksiz bildirim GÖNDERME. Kullanıcıyı rahatsız etme.
- Sabah (9-10 arası) kısa bir "günaydın" özeti uygun olabilir.
- Akşam (20-21 arası) günü değerlendirme uygun olabilir.
- Hedef takibi için samimi ama kısa ol: "Go'da ne kadar ilerleme var?"
- Mood düşükse nazik ol, zorlama.
- Optimal zaman değilse priority düşür.

SADECE şu formatta JSON yanıt ver:
{
  "action": "notify" | "skip",
  "type": "summary" | "goal_followup" | "memory_followup" | "mood_check" | "nudge" | "none",
  "priority": "low" | "medium" | "high",
  "message": "Türkçe kısa mesaj veya null",
  "reason": "kısa açıklama"
}`;

  const prompt = `Bağlam:
${contextSummary}

Bu durumda proaktif bildirim göndermeli miyim?`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error("[LivingAssistant] Haiku API error:", response.status);
      return { shouldNotify: false, priority: "low", type: "none", message: null, reason: "api_error" };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content.find((c) => c.type === "text")?.text || "";

    // Try to parse JSON response
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          action: string;
          type: string;
          priority: string;
          message: string | null;
          reason: string;
        };

        if (parsed.action === "notify" && parsed.message) {
          return {
            shouldNotify: true,
            priority: (parsed.priority || "low") as "low" | "medium" | "high",
            type: (parsed.type || "nudge") as ProactiveDecision["type"],
            message: parsed.message,
            reason: parsed.reason || "haiku_decision",
          };
        }
      }
    } catch {
      // Fall back to regex parsing
      const notifyMatch = text.match(/NOTIFY:\s*(yes|no)/i);
      const priorityMatch = text.match(/PRIORITY:\s*(low|medium|high)/i);
      const messageMatch = text.match(/MESSAGE:\s*(.+?)(?:\n|$)/i);

      const shouldNotify = notifyMatch?.[1]?.toLowerCase() === "yes";
      const priority = (priorityMatch?.[1]?.toLowerCase() || "low") as "low" | "medium" | "high";
      const message = messageMatch?.[1]?.trim();

      if (shouldNotify && message && message.toLowerCase() !== "none") {
        return { shouldNotify: true, priority, type: "nudge", message, reason: "haiku_decision" };
      }
    }

    return { shouldNotify: false, priority: "low", type: "none", message: null, reason: "haiku_skip" };
  } catch (error) {
    console.error("[LivingAssistant] Haiku analysis error:", error);
    return { shouldNotify: false, priority: "low", type: "none", message: null, reason: "analysis_error" };
  }
}

/**
 * Send proactive notification to user
 */
async function sendNotification(
  userId: number,
  message: string,
  priority: "low" | "medium" | "high" | "urgent",
  type: ProactiveDecision["type"]
): Promise<void> {
  if (!bot) return;

  try {
    // Add priority emoji
    let prefix = "";
    switch (priority) {
      case "urgent":
        prefix = "🚨 ";
        break;
      case "high":
        prefix = "❗ ";
        break;
      case "medium":
        prefix = "💡 ";
        break;
      default:
        prefix = "✨ ";
    }

    await bot.api.sendMessage(userId, `${prefix}${message}`);
    lastNotificationTime.set(userId, Date.now());

    // Set appropriate cooldown based on type
    switch (type) {
      case "goal_followup":
        // Extract goal ID from context if available and set cooldown
        setCooldown(`goal_generic`, type);
        break;
      case "memory_followup":
        setCooldown("memory_followup", type);
        break;
      case "summary":
        if (new Date().getHours() < 12) {
          setCooldown("morning_summary", type);
        } else {
          setCooldown("evening_reflection", type);
        }
        break;
      case "mood_check":
        setCooldown("mood_check", type);
        break;
      case "nudge":
        setCooldown("nudge", type);
        break;
    }

    // Persist cooldowns and notification time
    if (config.FF_SESSION_STATE) {
      const cooldownObj: Record<string, { lastSent: number; type: string }> = {};
      for (const [key, entry] of cooldowns.entries()) cooldownObj[key] = entry;
      updateSessionState(userId, { lastNotificationTime: Date.now(), cooldowns: cooldownObj });
    }

    console.log(`[LivingAssistant] Sent ${priority}/${type} notification to user ${userId}`);
  } catch (error) {
    console.error(`[LivingAssistant] Failed to send notification:`, error);
  }
}

/**
 * Extract mood from user message (called after message processing)
 * Returns extracted mood or null if not detectable
 */
export async function extractMoodFromMessage(
  userId: number,
  message: string,
  response: string
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  // Only analyze longer messages that might contain mood signals
  if (message.length < 10) return;

  try {
    const result = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 100,
        system: `Mesajdan ruh hali çıkar. SADECE şu formatta JSON döndür:
{"mood": "great|good|neutral|low|bad", "energy": 1-5, "confidence": 0.0-1.0, "triggers": ["neden1"]}
Eğer mood belirlenemiyorsa: {"mood": null}`,
        messages: [
          {
            role: "user",
            content: `Kullanıcı mesajı: "${message.slice(0, 500)}"`,
          },
        ],
      }),
    });

    if (!result.ok) return;

    const data = (await result.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content.find((c) => c.type === "text")?.text || "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          mood: MoodType | null;
          energy?: number;
          confidence?: number;
          triggers?: string[];
        };

        if (parsed.mood && parsed.confidence && parsed.confidence >= 0.5) {
          const moodService = await getMoodTrackingService(userId);
          moodService.recordMood({
            mood: parsed.mood,
            energy: parsed.energy ?? 3,
            context: message.slice(0, 100),
            triggers: parsed.triggers ?? [],
            source: "inferred",
            confidence: parsed.confidence,
          });

          console.log(`[LivingAssistant] Inferred mood: ${parsed.mood} (confidence: ${parsed.confidence})`);
        }
      }
    } catch {
      // Parsing failed, ignore
    }
  } catch (error) {
    // Silently fail - mood extraction is optional
    console.warn("[LivingAssistant] Mood extraction failed:", error);
  }
}

/**
 * Record activity for pattern learning
 */
export async function recordUserActivity(userId: number): Promise<void> {
  try {
    const patternService = await getActivityPatternService(userId);
    patternService.recordInteraction();
  } catch (error) {
    console.warn("[LivingAssistant] Activity recording failed:", error);
  }
}

/**
 * Code Review Cycle — daily proactive code observation
 * Reads one source file per day, analyzes with Haiku, saves as code-obs memory
 */
async function maybeRunCodeReview(userId: number): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const today = now.toISOString().slice(0, 10);

  // Only run between 14:00-15:00, once per day
  if (hour !== 14) return;
  if (lastCodeReviewDate === today) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  // Pick next file in rotation
  const filePath = CODE_REVIEW_FILES[codeReviewIndex % CODE_REVIEW_FILES.length]!;
  codeReviewIndex++;
  lastCodeReviewDate = today;

  // Persist code review state
  if (config.FF_SESSION_STATE) {
    updateSessionState(config.MY_TELEGRAM_ID, { codeReviewIndex, lastCodeReviewDate: today });
  }

  const fullPath = `/home/fjds/projects/cobrain/${filePath}`;

  console.log(`[CodeReview] Starting daily review: ${filePath}`);

  try {
    // Read the file
    const file = Bun.file(fullPath);
    if (!(await file.exists())) {
      console.warn(`[CodeReview] File not found: ${fullPath}`);
      return;
    }

    const content = await file.text();

    // Truncate if too long (keep first 4000 chars for Haiku context)
    const truncated = content.length > 4000 ? content.slice(0, 4000) + "\n\n[... truncated ...]" : content;

    // Analyze with Haiku
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
[
  {
    "type": "bug" | "improvement" | "performance" | "architecture" | "cleanup",
    "priority": "low" | "medium" | "high",
    "observation": "kısa açıklama",
    "suggestion": "öneri"
  }
]
Sadece gerçek, somut gözlemler yaz. Bulgu yoksa boş array döndür: []
Maksimum 3 gözlem.`,
        messages: [
          {
            role: "user",
            content: `Dosya: ${filePath}\n\n${truncated}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(`[CodeReview] Haiku API error: ${response.status}`);
      return;
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content.find((c) => c.type === "text")?.text || "";

    // Parse observations
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`[CodeReview] No observations for ${filePath}`);
      return;
    }

    const observations = JSON.parse(jsonMatch[0]) as Array<{
      type: string;
      priority: string;
      observation: string;
      suggestion: string;
    }>;

    if (observations.length === 0) {
      console.log(`[CodeReview] No issues found in ${filePath}`);
      return;
    }

    // Save each observation to smart-memory
    const userFolder = userManager.getUserFolder(userId);
    const memory = new SmartMemory(userFolder, userId);

    let highPriorityBugs: string[] = [];

    for (const obs of observations) {
      const content = `[code-obs] [${obs.type}] [${obs.priority}] Dosya: ${filePath}\nGözlem: ${obs.observation}\nÖneri: ${obs.suggestion}`;

      await memory.store({
        type: "semantic",
        content,
        summary: `[code-obs] ${filePath}: ${obs.observation.slice(0, 80)}`,
        importance: obs.priority === "high" ? 0.9 : obs.priority === "medium" ? 0.7 : 0.5,
        source: "code-review-cycle",
        metadata: {
          file: filePath,
          obsType: obs.type,
          priority: obs.priority,
          date: today,
        },
      });

      // Track high priority bugs for notification
      if (obs.priority === "high" && obs.type === "bug") {
        highPriorityBugs.push(`${filePath}: ${obs.observation}`);
      }
    }

    memory.close();

    console.log(`[CodeReview] ${observations.length} observation(s) saved for ${filePath}`);

    // Notify user about high priority bugs only
    if (highPriorityBugs.length > 0 && bot) {
      const bugMsg = highPriorityBugs.map((b) => `- ${b}`).join("\n");
      await bot.api.sendMessage(
        userId,
        `🐛 Code review'da yüksek öncelikli bug buldum:\n${bugMsg}\n\nDetay: recall("code-obs") ile bakabilirsin.`
      );
    }
  } catch (error) {
    console.error(`[CodeReview] Error reviewing ${filePath}:`, error);
  }
}

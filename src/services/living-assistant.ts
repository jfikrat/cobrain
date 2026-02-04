/**
 * Living Assistant - AI-powered proactive awareness
 * Uses Haiku for cheap, fast context analysis
 * Cobrain v0.7
 */

import { Bot } from "grammy";
import { userManager } from "./user-manager.ts";
import { getGoalsService } from "./goals.ts";
import { config } from "../config.ts";
import { heartbeat } from "./heartbeat.ts";

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
}

interface ProactiveDecision {
  shouldNotify: boolean;
  priority: "low" | "medium" | "high" | "urgent";
  message: string | null;
  reason: string;
}

let bot: Bot | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let lastNotificationTime = new Map<number, number>();
let lastInteractionTime = new Map<number, number>();

// Minimum time between proactive notifications (5 minutes)
const MIN_NOTIFICATION_INTERVAL = 5 * 60 * 1000;

/**
 * Initialize the living assistant
 */
export function initLivingAssistant(botInstance: Bot): void {
  bot = botInstance;

  // Start the awareness loop
  const interval = config.HEARTBEAT_LOG_INTERVAL_MS || 30_000;
  intervalId = setInterval(() => {
    runAwarenessLoop();
  }, interval);

  console.log(`[LivingAssistant] Started (interval: ${interval}ms)`);
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
}

/**
 * Main awareness loop - runs every 30 seconds
 */
async function runAwarenessLoop(): Promise<void> {
  heartbeat("proactive_service", { event: "awareness_tick" });

  const users = userManager.getAllUsers();

  for (const user of users) {
    try {
      await checkUserContext(user.id);
    } catch (error) {
      console.error(`[LivingAssistant] Error for user ${user.id}:`, error);
    }
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
    await sendNotification(userId, quickDecision.message, quickDecision.priority);
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
    await sendNotification(userId, aiDecision.message, aiDecision.priority);
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
  };
}

/**
 * Quick rule-based decision (no AI needed)
 */
function makeQuickDecision(context: ContextData): ProactiveDecision {
  // Urgent: Overdue reminders
  if (context.reminders.overdue.length > 0) {
    const overdue = context.reminders.overdue[0]!;
    return {
      shouldNotify: true,
      priority: "urgent",
      message: `⏰ Kaçırdığın hatırlatıcı: "${overdue.title}"`,
      reason: "overdue_reminder",
    };
  }

  // High: Reminder in next 5 minutes
  const imminentReminder = context.reminders.upcoming.find((r) => r.minutesLeft <= 5);
  if (imminentReminder) {
    return {
      shouldNotify: true,
      priority: "high",
      message: `⏰ ${imminentReminder.minutesLeft} dakika içinde: "${imminentReminder.title}"`,
      reason: "imminent_reminder",
    };
  }

  // High: Goal deadline today
  const todayDeadline = context.goals.approaching.find((g) => g.daysLeft === 0);
  if (todayDeadline) {
    return {
      shouldNotify: true,
      priority: "high",
      message: `🎯 Bugün deadline: "${todayDeadline.title}"`,
      reason: "today_deadline",
    };
  }

  // No urgent action needed
  return {
    shouldNotify: false,
    priority: "low",
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
    return { shouldNotify: false, priority: "low", message: null, reason: "no_api_key" };
  }

  // Don't disturb at night unless urgent
  if (context.time.timeOfDay === "night" && context.time.hour >= 23) {
    return { shouldNotify: false, priority: "low", message: null, reason: "night_time" };
  }

  // Build context summary for Haiku
  const contextSummary = `
Şu an: ${context.time.dayName}, saat ${context.time.hour}:00 (${context.time.timeOfDay})
Aktif hedef sayısı: ${context.goals.active}
Yaklaşan deadline'lar: ${context.goals.approaching.map((g) => `"${g.title}" (${g.daysLeft} gün)`).join(", ") || "yok"}
Bekleyen hatırlatıcı: ${context.reminders.pending}
Yaklaşan hatırlatıcılar (30dk): ${context.reminders.upcoming.map((r) => `"${r.title}" (${r.minutesLeft}dk)`).join(", ") || "yok"}
Son etkileşim: ${context.lastInteraction.minutesAgo} dakika önce
`.trim();

  const systemPrompt = `Sen kişisel bir asistansın. Kullanıcının bağlamını analiz et ve proaktif bir bildirim gerekip gerekmediğine karar ver.

Kurallar:
- Gereksiz bildirim GÖNDERME. Kullanıcıyı rahatsız etme.
- Sadece gerçekten faydalı, zamanında ve önemli bildirimler gönder.
- Sabah (9-10 arası) kısa bir "günaydın" özeti uygun olabilir.
- Akşam (20-21 arası) günü değerlendirme uygun olabilir.
- Kullanıcı son 30 dakikada etkileşim kurmuşsa, muhtemelen zaten meşgul - rahatsız etme.

SADECE şu formatta yanıt ver:
NOTIFY: yes/no
PRIORITY: low/medium/high
MESSAGE: [Türkçe kısa mesaj veya "none"]
REASON: [kısa açıklama]`;

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
        max_tokens: 200,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error("[LivingAssistant] Haiku API error:", response.status);
      return { shouldNotify: false, priority: "low", message: null, reason: "api_error" };
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content.find((c) => c.type === "text")?.text || "";

    // Parse response
    const notifyMatch = text.match(/NOTIFY:\s*(yes|no)/i);
    const priorityMatch = text.match(/PRIORITY:\s*(low|medium|high)/i);
    const messageMatch = text.match(/MESSAGE:\s*(.+?)(?:\n|$)/i);
    const reasonMatch = text.match(/REASON:\s*(.+?)(?:\n|$)/i);

    const shouldNotify = notifyMatch?.[1]?.toLowerCase() === "yes";
    const priority = (priorityMatch?.[1]?.toLowerCase() || "low") as "low" | "medium" | "high";
    const message = messageMatch?.[1]?.trim();
    const reason = reasonMatch?.[1]?.trim() || "haiku_decision";

    if (shouldNotify && message && message.toLowerCase() !== "none") {
      return { shouldNotify: true, priority, message, reason };
    }

    return { shouldNotify: false, priority: "low", message: null, reason };
  } catch (error) {
    console.error("[LivingAssistant] Haiku analysis error:", error);
    return { shouldNotify: false, priority: "low", message: null, reason: "analysis_error" };
  }
}

/**
 * Send proactive notification to user
 */
async function sendNotification(
  userId: number,
  message: string,
  priority: "low" | "medium" | "high" | "urgent"
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

    console.log(`[LivingAssistant] Sent ${priority} notification to user ${userId}`);
  } catch (error) {
    console.error(`[LivingAssistant] Failed to send notification:`, error);
  }
}

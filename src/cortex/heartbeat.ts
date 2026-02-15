/**
 * Cortex Heartbeat Emitter
 *
 * Periyodik sinyal üretici — sabah brifingi, akşam değerlendirmesi,
 * inaktivite kontrolü, hafıza yansıması, hedef hatırlatması.
 *
 * Her 60 saniyede bir kontrol eder, cooldown ile tekrar emisyonu engeller.
 * Tüm context gathering try/catch ile sarılır — kısmi veri ile de emit eder.
 */

import { config } from "../config.ts";
import { signalBus } from "./signal-bus.ts";
import { userManager } from "../services/user-manager.ts";
import { getGoalsService } from "../services/goals.ts";
import { getMoodTrackingService } from "../services/mood-tracking.ts";
import { getSessionState } from "../services/session-state.ts";
import { SmartMemory } from "../memory/smart-memory.ts";

// ── Cooldown Defaults ────────────────────────────────────────────────────

const COOLDOWNS: Record<string, number> = {
  morning_briefing: 23 * 60 * 60 * 1000,     // 23h (1/day)
  evening_reflection: 23 * 60 * 60 * 1000,   // 23h (1/day)
  inactivity_check: 3 * 60 * 60 * 1000,      // 3h
  memory_reflection: 6 * 24 * 60 * 60 * 1000, // 6 days
  goal_nudge: 47 * 60 * 60 * 1000,           // ~2 days
};

// ── State ────────────────────────────────────────────────────────────────

const lastEmitted = new Map<string, number>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────

function isInCooldown(type: string): boolean {
  const last = lastEmitted.get(type);
  if (!last) return false;
  const cooldown = COOLDOWNS[type] ?? 0;
  return Date.now() - last < cooldown;
}

function markEmitted(type: string): void {
  lastEmitted.set(type, Date.now());
}

// ── Context Gatherers ────────────────────────────────────────────────────

async function gatherMorningBriefing(userId: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};

  try {
    const db = await userManager.getUserDb(userId);
    const goalsService = await getGoalsService(db, userId);
    const activeGoals = goalsService.getActiveGoals();
    const dueReminders = goalsService.getDueReminders();
    data.activeGoals = activeGoals.length;
    data.goals = activeGoals.slice(0, 3).map(g => g.title);
    data.dueReminders = dueReminders.length;
  } catch (err) {
    console.warn("[Heartbeat] morning_briefing goals/reminders failed:", err);
  }

  try {
    const moodService = await getMoodTrackingService(userId);
    const mood = moodService.getCurrentMood();
    data.mood = mood?.mood ?? null;
  } catch (err) {
    console.warn("[Heartbeat] morning_briefing mood failed:", err);
  }

  return data;
}

async function gatherEveningReflection(userId: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};

  try {
    const moodService = await getMoodTrackingService(userId);
    const trend = moodService.getMoodTrend(1); // today
    data.moodTrend = trend.direction;
  } catch (err) {
    console.warn("[Heartbeat] evening_reflection mood failed:", err);
  }

  try {
    const db = await userManager.getUserDb(userId);
    const goalsService = await getGoalsService(db, userId);
    const needFollowup = goalsService.getGoalsNeedingFollowup();
    data.needFollowup = needFollowup.length;
    data.goals = needFollowup.slice(0, 3).map(g => g.title);
  } catch (err) {
    console.warn("[Heartbeat] evening_reflection goals failed:", err);
  }

  return data;
}

async function gatherInactivityCheck(userId: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};

  try {
    const state = getSessionState(userId);
    const minutesAgo = Math.floor((Date.now() - state.lastInteractionTime) / 60000);
    data.lastInteractionMinutesAgo = minutesAgo;
  } catch (err) {
    console.warn("[Heartbeat] inactivity_check session state failed:", err);
  }

  try {
    const db = await userManager.getUserDb(userId);
    const goalsService = await getGoalsService(db, userId);
    const dueReminders = goalsService.getDueReminders();
    const needFollowup = goalsService.getGoalsNeedingFollowup();
    data.pendingItems = dueReminders.length + needFollowup.length;
  } catch (err) {
    console.warn("[Heartbeat] inactivity_check pending items failed:", err);
  }

  return data;
}

async function gatherMemoryReflection(userId: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};

  let memory: SmartMemory | null = null;
  try {
    const userFolder = userManager.getUserFolder(userId);
    memory = new SmartMemory(userFolder, userId);
    const stats = memory.getStats();
    const topMemories = memory.getByImportance(5, 0.6);
    data.totalMemories = stats.total;
    data.topTopics = topMemories.map(m => m.summary || m.content.slice(0, 50));
  } catch (err) {
    console.warn("[Heartbeat] memory_reflection failed:", err);
  } finally {
    try { memory?.close(); } catch { /* ignore close errors */ }
  }

  return data;
}

async function gatherGoalNudge(userId: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};

  try {
    const db = await userManager.getUserDb(userId);
    const goalsService = await getGoalsService(db, userId);

    const activeGoals = goalsService.getActiveGoals();
    const approaching = activeGoals.filter(g =>
      g.dueDate && new Date(g.dueDate).getTime() - Date.now() < 3 * 24 * 60 * 60 * 1000
    );
    data.approachingDeadlines = approaching.map(g => ({
      title: g.title,
      daysLeft: Math.ceil((new Date(g.dueDate!).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
    }));

    const stalled = goalsService.getGoalsNeedingFollowup();
    data.stalledGoals = stalled.map(g => g.title);
  } catch (err) {
    console.warn("[Heartbeat] goal_nudge failed:", err);
  }

  return data;
}

// ── Main Check & Emit ────────────────────────────────────────────────────

async function checkAndEmit(userId: number): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0 = Sunday

  // morning_briefing — configurable hour, at :30
  if (hour === config.HEARTBEAT_MORNING_HOUR && minute === 30) {
    if (!isInCooldown("morning_briefing")) {
      const data = await gatherMorningBriefing(userId);
      signalBus.push("time_tick", "morning_briefing", data, { userId });
      markEmitted("morning_briefing");
      console.log("[Heartbeat] Emitting morning_briefing");
    }
  }

  // evening_reflection — configurable hour, at :00
  if (hour === config.HEARTBEAT_EVENING_HOUR && minute === 0) {
    if (!isInCooldown("evening_reflection")) {
      const data = await gatherEveningReflection(userId);
      signalBus.push("time_tick", "evening_reflection", data, { userId });
      markEmitted("evening_reflection");
      console.log("[Heartbeat] Emitting evening_reflection");
    }
  }

  // inactivity_check — every hour at :00, only if user inactive > threshold
  if (minute === 0) {
    if (!isInCooldown("inactivity_check")) {
      try {
        const state = getSessionState(userId);
        const minutesSinceInteraction = (Date.now() - state.lastInteractionTime) / 60000;
        if (minutesSinceInteraction > config.HEARTBEAT_INACTIVITY_HOURS * 60) {
          const data = await gatherInactivityCheck(userId);
          signalBus.push("time_tick", "inactivity_check", data, { userId });
          markEmitted("inactivity_check");
          console.log("[Heartbeat] Emitting inactivity_check");
        }
      } catch (err) {
        console.warn("[Heartbeat] inactivity_check pre-check failed:", err);
      }
    }
  }

  // memory_reflection — Sunday at 10:00
  if (dayOfWeek === 0 && hour === 10 && minute === 0) {
    if (!isInCooldown("memory_reflection")) {
      const data = await gatherMemoryReflection(userId);
      signalBus.push("time_tick", "memory_reflection", data, { userId });
      markEmitted("memory_reflection");
      console.log("[Heartbeat] Emitting memory_reflection");
    }
  }

  // goal_nudge — daily at 14:00, cooldown ~2 days
  if (hour === 14 && minute === 0) {
    if (!isInCooldown("goal_nudge")) {
      const data = await gatherGoalNudge(userId);
      signalBus.push("time_tick", "goal_nudge", data, { userId });
      markEmitted("goal_nudge");
      console.log("[Heartbeat] Emitting goal_nudge");
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export function startHeartbeat(userId: number): void {
  if (!config.ENABLE_AUTONOMOUS || !config.ENABLE_HEARTBEAT_SIGNALS) {
    console.log("[Heartbeat] Disabled (ENABLE_AUTONOMOUS=%s, ENABLE_HEARTBEAT_SIGNALS=%s)",
      config.ENABLE_AUTONOMOUS, config.ENABLE_HEARTBEAT_SIGNALS);
    return;
  }

  if (intervalHandle) {
    console.warn("[Heartbeat] Already running, skipping duplicate start");
    return;
  }

  intervalHandle = setInterval(() => {
    checkAndEmit(userId).catch(err => {
      console.error("[Heartbeat] checkAndEmit error:", err);
    });
  }, 60_000);

  console.log("[Heartbeat] Started — checking every 60s for userId=%d", userId);
}

export function stopHeartbeat(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[Heartbeat] Stopped");
  }
}

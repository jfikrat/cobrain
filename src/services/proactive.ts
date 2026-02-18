/**
 * Proactive Service - Handles scheduled task execution
 * Cobrain v0.5 - Stem edition: WA classification removed (Stem handles it)
 */

import { Bot } from "grammy";
import { getScheduler } from "./scheduler.ts";
import { getTaskQueue } from "./task-queue.ts";
import { getGoalsService } from "./goals.ts";
import { userManager } from "./user-manager.ts";
import { pruneMemories, think } from "../brain/index.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import type { ScheduledTask, QueuedTask, TaskResult } from "../types/autonomous.ts";
import { config as appConfig } from "../config.ts";
import { consolidateMemories } from "./memory-consolidation.ts";
import { recordInteraction, recordUserActivity } from "./interaction-tracker.ts";

let bot: Bot | null = null;

// Re-export for use in telegram channel (from interaction-tracker)
export { recordInteraction, recordUserActivity };

/**
 * Initialize proactive infrastructure (scheduler + task-queue handlers).
 * Timer-based polling (WhatsApp checker, reminder checker) removed — BrainLoop handles those.
 */
export function initProactiveInfra(botInstance: Bot): void {
  bot = botInstance;

  const scheduler = getScheduler();
  const taskQueue = getTaskQueue();

  // Register scheduled task handlers
  scheduler.registerHandler("daily_summary", handleDailySummary);
  scheduler.registerHandler("goal_check", handleGoalCheck);
  scheduler.registerHandler("reminder", handleReminder);
  scheduler.registerHandler("memory_prune", handleMemoryPrune);
  scheduler.registerHandler("memory_consolidation", handleMemoryConsolidation);

  // Register queue task handlers
  taskQueue.registerHandler("reminder", handleReminderTask);
  taskQueue.registerHandler("daily_summary", handleDailySummaryTask);
  taskQueue.registerHandler("goal_check", handleGoalCheckTask);
  taskQueue.registerHandler("memory_prune", handleMemoryPruneTask);
  taskQueue.registerHandler("memory_consolidation", handleMemoryConsolidationTask);

  // Backfill: ensure memory_consolidation task exists for the primary user
  if (appConfig.FF_MEMORY_CONSOLIDATION) {
    scheduler.ensureTask(appConfig.MY_TELEGRAM_ID, "memory_consolidation", "0 4 * * 0", { enabled: true });
  }

  // Start services
  scheduler.start();
  taskQueue.start();

  console.log("[Proactive] Infrastructure initialized (scheduler + task-queue)");
}

/**
 * Stop proactive infrastructure
 */
export function stopProactiveInfra(): void {
  const scheduler = getScheduler();
  const taskQueue = getTaskQueue();

  scheduler.stop();
  taskQueue.stop();

  console.log("[Proactive] Infrastructure stopped");
}

// ========== SCHEDULED TASK HANDLERS ==========

async function handleDailySummary(task: ScheduledTask): Promise<void> {
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "daily_summary", { scheduledTaskId: task.id }, 1, `scheduled:${task.id}`);
}

async function handleGoalCheck(task: ScheduledTask): Promise<void> {
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "goal_check", { scheduledTaskId: task.id }, 1, `scheduled:${task.id}`);
}

async function handleReminder(_task: ScheduledTask): Promise<void> {
  // Reminders are now handled by BrainLoop → Stem
}

async function handleMemoryPrune(task: ScheduledTask): Promise<void> {
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "memory_prune", { scheduledTaskId: task.id }, 0, `scheduled:${task.id}`);
}

async function handleMemoryConsolidation(task: ScheduledTask): Promise<void> {
  if (!appConfig.FF_MEMORY_CONSOLIDATION) return;
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "memory_consolidation", { scheduledTaskId: task.id }, 0, `scheduled:${task.id}`);
}

// ========== QUEUE TASK HANDLERS ==========

async function handleDailySummaryTask(task: QueuedTask): Promise<TaskResult> {
  if (!bot) {
    return { success: false, error: "Bot not initialized" };
  }

  try {
    const db = await userManager.getUserDb(task.userId);
    const goalsService = await getGoalsService(db, task.userId);

    const goals = goalsService.getActiveGoals();
    const reminders = goalsService.getPendingReminders();
    const stats = goalsService.getStats();

    let message = `<b>Günaydın! Günlük Özet</b>\n\n`;

    if (goals.length > 0) {
      message += `<b>Aktif Hedefler (${goals.length})</b>\n`;
      for (const goal of goals.slice(0, 3)) {
        const progress = Math.round(goal.progress * 100);
        message += `• ${goal.title} (${progress}%)\n`;
      }
      if (goals.length > 3) {
        message += `  <i>+${goals.length - 3} daha...</i>\n`;
      }
      message += "\n";
    }

    if (reminders.length > 0) {
      message += `<b>Bugünkü Hatırlatıcılar</b>\n`;
      const today = new Date();
      const todayReminders = reminders.filter((r) => {
        const triggerDate = new Date(r.triggerAt);
        return triggerDate.toDateString() === today.toDateString();
      });

      for (const reminder of todayReminders.slice(0, 3)) {
        const time = new Date(reminder.triggerAt).toLocaleTimeString("tr-TR", {
          hour: "2-digit",
          minute: "2-digit",
        });
        message += `• ${time} - ${reminder.title}\n`;
      }
      if (todayReminders.length === 0) {
        message += `  <i>Bugün için hatırlatıcı yok</i>\n`;
      }
      message += "\n";
    }

    message += `<b>İstatistikler</b>\n`;
    message += `• Aktif hedef: ${stats.activeGoals}\n`;
    message += `• Tamamlanan: ${stats.completedGoals}\n`;
    message += `• Bekleyen hatırlatıcı: ${stats.pendingReminders}\n`;

    message += `\n<i>İyi günler!</i>`;

    await bot.api.sendMessage(task.userId, message, { parse_mode: "HTML" });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleGoalCheckTask(task: QueuedTask): Promise<TaskResult> {
  if (!bot) {
    return { success: false, error: "Bot not initialized" };
  }

  try {
    const db = await userManager.getUserDb(task.userId);
    const goalsService = await getGoalsService(db, task.userId);

    const goals = goalsService.getActiveGoals();

    if (goals.length === 0) {
      return { success: true, message: "No active goals" };
    }

    let message = `<b>Haftalık Hedef Kontrolü</b>\n\n`;
    message += `Bu hafta hedeflerinize ne kadar yaklaştınız?\n\n`;

    for (const goal of goals) {
      const progress = Math.round(goal.progress * 100);
      const progressBar = "█".repeat(Math.floor(progress / 10)) + "░".repeat(10 - Math.floor(progress / 10));

      message += `<b>${goal.title}</b>\n`;
      message += `   ${progressBar} ${progress}%\n\n`;
    }

    message += `<i>Hedeflerinizi güncellemek için /goals yazın!</i>`;

    await bot.api.sendMessage(task.userId, message, { parse_mode: "HTML" });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleReminderTask(task: QueuedTask): Promise<TaskResult> {
  if (!bot) {
    return { success: false, error: "Bot not initialized" };
  }

  try {
    const { reminderId, title, message: reminderMessage } = task.payload as {
      reminderId: number;
      title: string;
      message?: string;
    };

    const actionText = reminderMessage || title;

    // Trigger agent to execute the reminder action
    console.log(`[Reminder] Triggering agent for reminder #${reminderId}: ${actionText}`);
    const response = await think(
      task.userId,
      `[SYSTEM] Hatırlatıcı tetiklendi: "${actionText}"\n\nBu hatırlatıcıyı şimdi yerine getir. Gerekli aksiyonu al (mesaj gönder, bilgi ver, vb.) ve kullanıcıya bildir.`
    );

    // Send agent's response to user via Telegram
    if (response.content) {
      await bot.api.sendMessage(task.userId, response.content);
    }

    // Mark reminder as sent
    const db = await userManager.getUserDb(task.userId);
    const goalsService = await getGoalsService(db, task.userId);
    goalsService.markReminderSent(reminderId);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMemoryPruneTask(task: QueuedTask): Promise<TaskResult> {
  try {
    const prunedCount = await pruneMemories(task.userId);

    return {
      success: true,
      message: `Pruned ${prunedCount} expired memories`,
      data: { prunedCount },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMemoryConsolidationTask(task: QueuedTask): Promise<TaskResult> {
  try {
    const result = await consolidateMemories(task.userId);

    return {
      success: result.errors.length === 0,
      message: `Consolidation: promoted=${result.promoted} merged=${result.merged} conflicts=${result.conflictsResolved} rebalance=${result.rebalanced.up}↑/${result.rebalanced.down}↓ (${result.durationMs}ms)`,
      data: result,
      error: result.errors.length > 0 ? result.errors.join("; ") : undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

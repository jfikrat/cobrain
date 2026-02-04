/**
 * Proactive Service - Handles scheduled task execution
 * Cobrain v0.3 - Now with Living Assistant
 */

import { Bot } from "grammy";
import { getScheduler, type Scheduler } from "./scheduler.ts";
import { getTaskQueue, type TaskQueue } from "./task-queue.ts";
import { getGoalsService } from "./goals.ts";
import { userManager } from "./user-manager.ts";
import { pruneMemories } from "../brain/index.ts";
import { initLivingAssistant, stopLivingAssistant, recordInteraction } from "./living-assistant.ts";
import type { ScheduledTask, QueuedTask, TaskResult, TaskType } from "../types/autonomous.ts";

let bot: Bot | null = null;

// Re-export for use in telegram channel
export { recordInteraction };

/**
 * Initialize proactive services with bot instance
 */
export function initProactive(botInstance: Bot): void {
  bot = botInstance;

  const scheduler = getScheduler();
  const taskQueue = getTaskQueue();

  // Register scheduled task handlers
  scheduler.registerHandler("daily_summary", handleDailySummary);
  scheduler.registerHandler("goal_check", handleGoalCheck);
  scheduler.registerHandler("reminder", handleReminder);
  scheduler.registerHandler("memory_prune", handleMemoryPrune);

  // Register queue task handlers
  taskQueue.registerHandler("reminder", handleReminderTask);
  taskQueue.registerHandler("daily_summary", handleDailySummaryTask);
  taskQueue.registerHandler("goal_check", handleGoalCheckTask);
  taskQueue.registerHandler("memory_prune", handleMemoryPruneTask);

  // Start services
  scheduler.start();
  taskQueue.start();

  // Start reminder check interval (every minute)
  startReminderChecker();

  // Start Living Assistant (AI-powered proactive awareness)
  initLivingAssistant(bot);

  console.log("[Proactive] Services initialized (with Living Assistant)");
}

/**
 * Stop proactive services
 */
export function stopProactive(): void {
  const scheduler = getScheduler();
  const taskQueue = getTaskQueue();

  scheduler.stop();
  taskQueue.stop();

  if (reminderIntervalId) {
    clearInterval(reminderIntervalId);
    reminderIntervalId = null;
  }

  // Stop Living Assistant
  stopLivingAssistant();

  console.log("[Proactive] Services stopped");
}

// ========== SCHEDULED TASK HANDLERS ==========

async function handleDailySummary(task: ScheduledTask): Promise<void> {
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "daily_summary", { scheduledTaskId: task.id }, 1);
}

async function handleGoalCheck(task: ScheduledTask): Promise<void> {
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "goal_check", { scheduledTaskId: task.id }, 1);
}

async function handleReminder(task: ScheduledTask): Promise<void> {
  // This is triggered by the scheduler, but actual reminders
  // are handled by the reminder checker below
}

async function handleMemoryPrune(task: ScheduledTask): Promise<void> {
  const taskQueue = getTaskQueue();
  taskQueue.enqueue(task.userId, "memory_prune", { scheduledTaskId: task.id }, 0);
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

    let message = `🌅 <b>Günaydın! Günlük Özet</b>\n\n`;

    if (goals.length > 0) {
      message += `🎯 <b>Aktif Hedefler (${goals.length})</b>\n`;
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
      message += `⏰ <b>Bugünkü Hatırlatıcılar</b>\n`;
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

    message += `📊 <b>İstatistikler</b>\n`;
    message += `• Aktif hedef: ${stats.activeGoals}\n`;
    message += `• Tamamlanan: ${stats.completedGoals}\n`;
    message += `• Bekleyen hatırlatıcı: ${stats.pendingReminders}\n`;

    message += `\n<i>İyi günler! 🌟</i>`;

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

    let message = `📋 <b>Haftalık Hedef Kontrolü</b>\n\n`;
    message += `Bu hafta hedeflerinize ne kadar yaklaştınız?\n\n`;

    for (const goal of goals) {
      const progress = Math.round(goal.progress * 100);
      const progressBar = "█".repeat(Math.floor(progress / 10)) + "░".repeat(10 - Math.floor(progress / 10));

      message += `🎯 <b>${goal.title}</b>\n`;
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

    const msgText = `⏰ <b>Hatırlatıcı!</b>\n\n${reminderMessage || title}`;

    await bot.api.sendMessage(task.userId, msgText, { parse_mode: "HTML" });

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

// ========== REMINDER CHECKER ==========

let reminderIntervalId: ReturnType<typeof setInterval> | null = null;

function startReminderChecker(): void {
  // Check for due reminders every minute
  reminderIntervalId = setInterval(async () => {
    await checkDueReminders();
  }, 60_000);

  // Initial check
  checkDueReminders();
}

async function checkDueReminders(): Promise<void> {
  const { config } = await import("../config.ts");
  const taskQueue = getTaskQueue();
  const userId = config.MY_TELEGRAM_ID;

  try {
    const db = await userManager.getUserDb(userId);
    const goalsService = await getGoalsService(db, userId);

    const dueReminders = goalsService.getDueReminders();

    for (const reminder of dueReminders) {
      // Queue the reminder task
      taskQueue.enqueue(
        userId,
        "reminder",
        {
          reminderId: reminder.id,
          title: reminder.title,
          message: reminder.message,
        },
        5 // High priority
      );
    }
  } catch (error) {
    console.error(`[Proactive] Error checking reminders:`, error);
  }
}

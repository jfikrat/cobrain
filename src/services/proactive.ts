/**
 * Proactive Service - Handles scheduled task execution
 * Cobrain v0.5 - Stem edition: WA classification removed (Stem handles it)
 */

import { Bot } from "grammy";
import { getScheduler } from "./scheduler.ts";
import { getTaskQueue } from "./task-queue.ts";
import { getRemindersService } from "./reminders.ts";
import { userManager } from "./user-manager.ts";
import { think } from "../brain/index.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import type { ScheduledTask, QueuedTask, TaskResult } from "../types/autonomous.ts";
import { config as appConfig } from "../config.ts";
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
  scheduler.registerHandler("reminder", handleReminder);
  scheduler.registerHandler("memory_prune", handleMemoryPrune);
  scheduler.registerHandler("memory_consolidation", handleMemoryConsolidation);

  // Register queue task handlers
  taskQueue.registerHandler("reminder", handleReminderTask);
  taskQueue.registerHandler("daily_summary", handleDailySummaryTask);
  taskQueue.registerHandler("memory_prune", handleMemoryPruneTask);
  taskQueue.registerHandler("memory_consolidation", handleMemoryConsolidationTask);

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

async function handleReminder(_task: ScheduledTask): Promise<void> {
  // No-op: Reminders are handled by BrainLoop
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
    const remindersService = await getRemindersService(db, task.userId);

    const reminders = remindersService.getPendingReminders();
    const pendingCount = remindersService.getPendingCount();

    let message = `<b>Good morning! Daily Summary</b>\n\n`;

    if (reminders.length > 0) {
      message += `<b>Today's Reminders</b>\n`;
      const today = new Date();
      const todayReminders = reminders.filter((r) => {
        const triggerDate = new Date(r.triggerAt);
        return triggerDate.toDateString() === today.toDateString();
      });

      for (const reminder of todayReminders.slice(0, 3)) {
        const time = new Date(reminder.triggerAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        message += `• ${time} - ${reminder.title}\n`;
      }
      if (todayReminders.length === 0) {
        message += `  <i>No reminders for today</i>\n`;
      }
      message += "\n";
    }

    message += `<b>Pending reminders:</b> ${pendingCount}\n`;
    message += `\n<i>Have a great day!</i>`;

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
      `[SYSTEM] Reminder triggered: "${actionText}"\n\nExecute this reminder now. Take the necessary action (send message, provide info, etc.) and notify the user.`
    );

    // Send agent's response to user via Telegram
    if (response.content) {
      await bot.api.sendMessage(task.userId, response.content);
    }

    // Mark reminder as sent
    const db = await userManager.getUserDb(task.userId);
    const remindersService = await getRemindersService(db, task.userId);
    remindersService.markReminderSent(reminderId);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function handleMemoryPruneTask(_task: QueuedTask): Promise<TaskResult> {
  // No-op: FileMemory has no TTL-based pruning
  return { success: true };
}

async function handleMemoryConsolidationTask(_task: QueuedTask): Promise<TaskResult> {
  // No-op: Mneme handles FileMemory consolidation
  return { success: true };
}

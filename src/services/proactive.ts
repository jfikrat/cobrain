/**
 * Proactive Service - Handles scheduled task execution
 * Cobrain v0.3 - Now with Living Assistant
 */

import { Bot } from "grammy";
import { heartbeat } from "./heartbeat.ts";
import { getScheduler, type Scheduler } from "./scheduler.ts";
import { getTaskQueue, type TaskQueue } from "./task-queue.ts";
import { getGoalsService } from "./goals.ts";
import { userManager } from "./user-manager.ts";
import { pruneMemories, think } from "../brain/index.ts";
import { initLivingAssistant, stopLivingAssistant, recordInteraction, recordUserActivity } from "./living-assistant.ts";
import { whatsappDB } from "./whatsapp-db.ts";
import type { ScheduledTask, QueuedTask, TaskResult, TaskType } from "../types/autonomous.ts";

let bot: Bot | null = null;

// Re-export for use in telegram channel (now from living-assistant)
export { recordInteraction, recordUserActivity };

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

  // Start WhatsApp DM notification checker (every 30 seconds)
  startWhatsAppNotificationChecker();

  // Start Living Assistant (AI-powered proactive awareness)
  initLivingAssistant(bot);

  // Heartbeat: proactive service started
  heartbeat("proactive_service", { event: "started" });

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

  if (whatsappNotifIntervalId) {
    clearInterval(whatsappNotifIntervalId);
    whatsappNotifIntervalId = null;
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

    const actionText = reminderMessage || title;

    // Trigger agent to execute the reminder action (WhatsApp, Telegram, etc.)
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

// ========== WHATSAPP DM NOTIFICATION CHECKER ==========

let whatsappNotifIntervalId: ReturnType<typeof setInterval> | null = null;

function startWhatsAppNotificationChecker(): void {
  if (!whatsappDB.isAvailable()) {
    console.log("[Proactive] WhatsApp DB unavailable, DM notifications disabled");
    return;
  }

  // Check every 30 seconds
  whatsappNotifIntervalId = setInterval(async () => {
    await checkWhatsAppNotifications();
  }, 30_000);

  // Initial check after 10 seconds (let everything start up first)
  setTimeout(() => checkWhatsAppNotifications(), 10_000);

  console.log("[Proactive] WhatsApp DM notification checker started (30s interval)");
}

async function checkWhatsAppNotifications(): Promise<void> {
  if (!bot) return;

  try {
    const notifications = whatsappDB.getPendingNotifications(10);
    if (notifications.length === 0) return;

    const { config } = await import("../config.ts");
    const userId = config.MY_TELEGRAM_ID;

    // Group notifications by sender for cleaner display
    const bySender = new Map<string, typeof notifications>();
    for (const notif of notifications) {
      const key = notif.sender_name || notif.chat_jid;
      if (!bySender.has(key)) bySender.set(key, []);
      bySender.get(key)!.push(notif);
    }

    // Build notification message
    let message = `<b>WhatsApp</b>\n\n`;

    for (const [sender, msgs] of bySender) {
      if (msgs.length === 1) {
        const msg = msgs[0];
        const typeLabel = msg.message_type === "audio" ? "[Ses] " :
                         msg.message_type === "image" ? "[Resim] " :
                         msg.message_type === "video" ? "[Video] " :
                         msg.message_type === "document" ? "[Dosya] " : "";
        const content = (msg.content || "").slice(0, 100);
        message += `<b>${escapeHtml(sender)}</b>: ${typeLabel}${escapeHtml(content)}\n`;
      } else {
        message += `<b>${escapeHtml(sender)}</b>: ${msgs.length} yeni mesaj\n`;
        // Show last message preview
        const last = msgs[msgs.length - 1];
        const content = (last.content || "").slice(0, 80);
        if (content) {
          message += `  <i>${escapeHtml(content)}</i>\n`;
        }
      }
    }

    // Send to Telegram
    await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });

    // Mark as read
    const ids = notifications.map((n) => n.id);
    whatsappDB.markNotificationsRead(ids);

    heartbeat("whatsapp_notifications", {
      sent: notifications.length,
      senders: bySender.size,
    });
  } catch (error) {
    console.error("[Proactive] WhatsApp notification check error:", error);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

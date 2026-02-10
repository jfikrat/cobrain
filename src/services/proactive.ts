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
    const allNotifications = whatsappDB.getPendingNotifications(10);
    if (allNotifications.length === 0) return;

    // Filter out old messages (>5 min) to avoid stale notifications after worker restart
    const nowSec = Math.floor(Date.now() / 1000);
    const MAX_AGE_SEC = 300; // 5 minutes
    const notifications = allNotifications.filter((n) => {
      const msgTs = (n as any).message_timestamp || 0;
      if (msgTs === 0) return true; // no timestamp = legacy, allow
      return (nowSec - msgTs) < MAX_AGE_SEC;
    });

    // Mark old ones as read immediately so they don't pile up
    const staleIds = allNotifications
      .filter((n) => !notifications.includes(n))
      .map((n) => n.id);
    if (staleIds.length > 0) {
      whatsappDB.markNotificationsRead(staleIds);
      console.log(`[Proactive] Skipped ${staleIds.length} stale notifications (>5min old)`);
    }

    if (notifications.length === 0) return;

    const { config } = await import("../config.ts");
    const userId = config.MY_TELEGRAM_ID;

    // Separate DMs and group messages
    const dms = notifications.filter((n) => !n.is_group);
    const groupMsgs = notifications.filter((n) => n.is_group);

    // --- DMs: AI analysis + smart reply ---
    if (dms.length > 0) {
      // Group by sender
      const bySender = new Map<string, typeof dms>();
      for (const notif of dms) {
        const key = notif.chat_jid; // group by chat JID for accurate reply targeting
        if (!bySender.has(key)) bySender.set(key, []);
        bySender.get(key)!.push(notif);
      }

      for (const [chatJid, msgs] of bySender) {
        await handleDMMessages(msgs, chatJid, userId);
      }
    }

    // --- Group messages: AI analysis + auto-reply ---
    if (groupMsgs.length > 0) {
      await handleWatchedGroupMessages(groupMsgs, userId);
    }

    // Mark all as read
    const ids = notifications.map((n) => n.id);
    whatsappDB.markNotificationsRead(ids);

    heartbeat("whatsapp_notifications", {
      sent: notifications.length,
      dms: dms.length,
      groups: groupMsgs.length,
    });
  } catch (error) {
    console.error("[Proactive] WhatsApp notification check error:", error);
  }
}

/**
 * Handle incoming DMs with AI analysis.
 *
 * Tier 1 - Auto-reply (no approval needed):
 *   Simple greetings, "are you available?", sticker/emoji responses
 *
 * Tier 2 - Notify + suggest reply (user approves):
 *   Questions, meeting requests, important messages
 *
 * Tier 3 - Just notify:
 *   Media, unclear messages, topics I don't know about
 */
async function handleDMMessages(
  messages: ReturnType<typeof whatsappDB.getPendingNotifications>,
  chatJid: string,
  telegramUserId: number
): Promise<void> {
  if (!bot) return;

  const senderName = messages[0].sender_name || chatJid.split("@")[0];
  const msgSummary = messages.map((m) => {
    const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
    return `${typeLabel}${m.content || ""}`;
  }).join("\n");

  const prompt = `[SYSTEM - WhatsApp DM Analizi]

"${senderName}" sana dogrudan mesaj gondermis:

${msgSummary}

Analiz et ve karar ver:

KATMAN 1 - Otomatik cevapla (onay gerektirmez):
- Basit selamlasmalar: selam, merhaba, gunaydin, nasilsin, naber
- "Musait misin?", "Uygun musun?" -> "Fekrat su an musait degil, en kisa surede doner"
- Tesekkur mesajlari -> kisa karsilik

KATMAN 2 - Kullaniciya sor (onay gerektirir):
- Soru iceren mesajlar (randevu, bulusma, bilgi istegi)
- Onemli konular, uzun mesajlar
- Cevap verilebilir ama emin degilsen

KATMAN 3 - Sadece bildir:
- Medya (resim, video, ses, dosya) -- sadece bildirim
- Belirsiz, anlamsiz veya konu disinda mesajlar
- Bilmedigin konular

KURALLAR:
- Sen Cobrain'sin, Fekrat'in AI asistani
- Samimi ama profesyonel ol
- Kisinin ismini kullan
- Kisa ve dogal yaz, uzun cumleler kurma

Yanit formati (JSON):
{
  "tier": 1 | 2 | 3,
  "reason": "kisa aciklama",
  "reply": "cevap metni (tier 1 icin otomatik gonderilecek)",
  "suggestedReply": "onerilen cevap (tier 2 icin kullaniciya gosterilecek)"
}

SADECE JSON dondur.`;

  try {
    const response = await think(telegramUserId, prompt);
    const content = response.content || "";

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fallback: just notify
      await sendDMNotification(messages, senderName, telegramUserId);
      return;
    }

    const analysis = JSON.parse(jsonMatch[0]);

    if (analysis.tier === 1 && analysis.reply) {
      // TIER 1: Auto-reply
      whatsappDB.addToOutbox(chatJid, analysis.reply);

      const notifyMsg = `<b>WhatsApp - ${escapeHtml(senderName)}</b>\n\n` +
        messages.map(m => {
          const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
          return `${typeLabel}${escapeHtml((m.content || "").slice(0, 80))}`;
        }).join("\n") +
        `\n\n<i>Otomatik cevap: "${escapeHtml(analysis.reply)}"</i>`;

      await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });
      console.log(`[Proactive] DM auto-replied to ${senderName}: ${analysis.reply}`);

    } else if (analysis.tier === 2 && analysis.suggestedReply) {
      // TIER 2: Notify + suggest
      const notifyMsg = `<b>WhatsApp - ${escapeHtml(senderName)}</b>\n\n` +
        messages.map(m => {
          const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
          return `${typeLabel}${escapeHtml((m.content || "").slice(0, 100))}`;
        }).join("\n") +
        `\n\n<b>Onerilen cevap:</b> <i>"${escapeHtml(analysis.suggestedReply)}"</i>` +
        `\n<i>${escapeHtml(analysis.reason || "")}</i>`;

      await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });

    } else {
      // TIER 3: Just notify
      await sendDMNotification(messages, senderName, telegramUserId);
    }
  } catch (error) {
    console.error(`[Proactive] DM analysis error for ${senderName}:`, error);
    await sendDMNotification(messages, senderName, telegramUserId);
  }
}

/** Simple DM notification (fallback / tier 3) */
async function sendDMNotification(
  messages: ReturnType<typeof whatsappDB.getPendingNotifications>,
  senderName: string,
  telegramUserId: number
): Promise<void> {
  if (!bot) return;

  let message = `<b>WhatsApp - ${escapeHtml(senderName)}</b>\n\n`;
  for (const m of messages) {
    const typeLabel = m.message_type === "audio" ? "[Ses] " :
                     m.message_type === "image" ? "[Resim] " :
                     m.message_type === "video" ? "[Video] " :
                     m.message_type === "document" ? "[Dosya] " : "";
    const content = (m.content || "").slice(0, 100);
    message += `${typeLabel}${escapeHtml(content)}\n`;
  }
  await bot.api.sendMessage(telegramUserId, message, { parse_mode: "HTML" });
}

/**
 * Analyze watched group messages with AI and auto-reply if appropriate.
 * Rules:
 * - NEVER reply to work groups (only watched/family groups)
 * - Only reply if message is clearly directed at Fekrat or easily answerable
 * - Inform user via Telegram about what happened
 */
async function handleWatchedGroupMessages(
  messages: ReturnType<typeof whatsappDB.getPendingNotifications>,
  telegramUserId: number
): Promise<void> {
  if (!bot) return;

  // Build context for AI
  const msgSummary = messages.map((m) => {
    return `[${m.sender_name}]: ${m.content || `[${m.message_type}]`}`;
  }).join("\n");

  const groupJid = messages[0].chat_jid;
  const groupName = messages[0].sender_name?.split(" @ ")[1] || groupJid;

  const prompt = `[SYSTEM - WhatsApp Grup Analizi]

Aile/kisisel grup "${groupName}" icinde yeni mesajlar var:

${msgSummary}

Analiz et:
1. Bu mesajlardan herhangi biri Fekrat'a (bana) yonelik mi? (direkt isim geciyor mu, soru soruluyor mu, cevap bekleniyor mu)
2. Kolayca cevaplayabilecegim bir sey var mi? (selamlasma, basit soru, tesekkur vb.)

KURALLAR:
- Bu bir AILE grubu, samimi ol
- Eger cevap vermek uygunsa, kisa ve dogal bir cevap yaz
- Eger cevap vermek uygun degilse veya emin degilsen, CEVAP VERME
- Is gruplarina ASLA mesaj atma (bu zaten sadece izlenen gruplarda calisir)
- Hitap kurallari: Inci Hanim, Feyzullah Bey icin hanim/bey kullan. Alicem ve Doga icin samimi ol.

Yanit formatı (JSON):
{
  "shouldReply": true/false,
  "reason": "neden cevap verilmeli/verilmemeli (kisa)",
  "reply": "cevap metni (sadece shouldReply=true ise)",
  "notifyUser": "Telegram'a gonderilecek bildirim mesaji"
}

SADECE JSON dondur, baska bir sey yazma.`;

  try {
    const response = await think(telegramUserId, prompt);
    const content = response.content || "";

    // Try to parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Couldn't parse, just notify
      let message = `<b>WhatsApp - ${escapeHtml(groupName)}</b>\n\n`;
      for (const m of messages) {
        const sender = (m.sender_name || "").split(" @ ")[0];
        message += `<b>${escapeHtml(sender)}</b>: ${escapeHtml((m.content || "").slice(0, 100))}\n`;
      }
      await bot.api.sendMessage(telegramUserId, message, { parse_mode: "HTML" });
      return;
    }

    const analysis = JSON.parse(jsonMatch[0]);

    if (analysis.shouldReply && analysis.reply) {
      // Auto-reply via WhatsApp outbox
      whatsappDB.addToOutbox(groupJid, analysis.reply);

      // Notify user what we did
      const notifyMsg = `<b>WhatsApp - ${escapeHtml(groupName)}</b>\n\n` +
        messages.map(m => {
          const sender = (m.sender_name || "").split(" @ ")[0];
          return `<b>${escapeHtml(sender)}</b>: ${escapeHtml((m.content || "").slice(0, 80))}`;
        }).join("\n") +
        `\n\n<i>Otomatik cevap gonderdim: "${escapeHtml(analysis.reply)}"</i>` +
        `\n<i>Sebep: ${escapeHtml(analysis.reason || "")}</i>`;

      await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });
      console.log(`[Proactive] Auto-replied to ${groupName}: ${analysis.reply}`);
    } else {
      // Just notify, no reply
      let message = `<b>WhatsApp - ${escapeHtml(groupName)}</b>\n\n`;
      for (const m of messages) {
        const sender = (m.sender_name || "").split(" @ ")[0];
        message += `<b>${escapeHtml(sender)}</b>: ${escapeHtml((m.content || "").slice(0, 100))}\n`;
      }
      if (analysis.reason) {
        message += `\n<i>${escapeHtml(analysis.reason)}</i>`;
      }
      await bot.api.sendMessage(telegramUserId, message, { parse_mode: "HTML" });
    }
  } catch (error) {
    console.error("[Proactive] Group message analysis error:", error);
    // Fallback: just notify
    let message = `<b>WhatsApp - ${escapeHtml(groupName)}</b>\n\n`;
    for (const m of messages) {
      const sender = (m.sender_name || "").split(" @ ")[0];
      message += `<b>${escapeHtml(sender)}</b>: ${escapeHtml((m.content || "").slice(0, 100))}\n`;
    }
    await bot.api.sendMessage(telegramUserId, message, { parse_mode: "HTML" });
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

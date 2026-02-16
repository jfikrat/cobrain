/**
 * Proactive Service - Handles scheduled task execution
 * Cobrain v0.4 - Simplified for BrainLoop integration
 */

import { Bot } from "grammy";
import { heartbeat } from "./heartbeat.ts";
import { getScheduler, type Scheduler } from "./scheduler.ts";
import { getTaskQueue, type TaskQueue } from "./task-queue.ts";
import { getGoalsService } from "./goals.ts";
import { userManager } from "./user-manager.ts";
import { pruneMemories, think } from "../brain/index.ts";
import { whatsappDB } from "./whatsapp-db.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import { signalBus } from "../cortex/index.ts";
import { classifyWhatsAppMessage, type TierClassification, type GroupClassification } from "./haiku.ts";
import type { ScheduledTask, QueuedTask, TaskResult, TaskType } from "../types/autonomous.ts";
import { addWhatsAppNotification } from "./session-state.ts";
import { config as appConfig } from "../config.ts";
import { markReplied, wasRecentlyReplied } from "./reply-dedup.ts";
import { sanitizeText } from "../cortex/sanitize.ts";
import { SmartMemory } from "../memory/smart-memory.ts";
import { consolidateMemories } from "./memory-consolidation.ts";
import { expectations } from "../cortex/expectations.ts";
import { recordInteraction, recordUserActivity } from "./interaction-tracker.ts";

let bot: Bot | null = null;

// ========== VALIDATION & SANITIZATION ==========

const INJECTION_PATTERNS = [
  /\[SYSTEM\]/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<<SYS>>/i,
  /Human:/i,
  /Assistant:/i,
];

/** Sanitize user message content before embedding in prompts */
function sanitizeForPrompt(text: string): string {
  let sanitized = text;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }
  return sanitized;
}

/** Validate reply before sending to WhatsApp */
function validateReply(reply: string, maxLength: number): { valid: boolean; reason?: string } {
  if (!reply || reply.trim().length === 0) {
    return { valid: false, reason: "empty_reply" };
  }
  if (reply.length > maxLength) {
    return { valid: false, reason: "too_long" };
  }
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(reply)) {
      return { valid: false, reason: "injection_pattern" };
    }
  }
  return { valid: true };
}

/** Processing result for heartbeat metrics */
interface ProcessingResult {
  tier?: number;
  outboxSuccess?: boolean;
  model: string;
  error?: string;
}

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

  // Heartbeat: proactive service started
  heartbeat("proactive_service", { event: "started" });

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

async function handleReminder(task: ScheduledTask): Promise<void> {
  // This is triggered by the scheduler, but actual reminders
  // are handled by the reminder checker below
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

// ========== REMINDER CHECKER (called by BrainLoop) ==========

export async function checkDueReminders(): Promise<void> {
  const { config } = await import("../config.ts");
  const taskQueue = getTaskQueue();
  const userId = config.MY_TELEGRAM_ID;

  try {
    const db = await userManager.getUserDb(userId);
    const goalsService = await getGoalsService(db, userId);

    const dueReminders = goalsService.getDueReminders();

    for (const reminder of dueReminders) {
      // Queue the reminder task (with dedup key to prevent double-enqueue)
      taskQueue.enqueue(
        userId,
        "reminder",
        {
          reminderId: reminder.id,
          title: reminder.title,
          message: reminder.message,
        },
        5, // High priority
        `reminder:${reminder.id}`
      );
    }
  } catch (error) {
    console.error(`[Proactive] Error checking reminders:`, error);
  }
}

// ========== WHATSAPP NOTIFICATION CHECKER (called by BrainLoop) ==========

export async function checkWhatsAppNotifications(): Promise<void> {
  if (!bot) return;

  const allNotifications = whatsappDB.getPendingNotifications(10);
  if (allNotifications.length === 0) return;

  // Track which IDs have been successfully processed so we only reset unprocessed ones on error
  const processedIds = new Set<number>();

  try {
    const { config } = await import("../config.ts");
    const userId = config.MY_TELEGRAM_ID;
    const maxAgeSec = config.WHATSAPP_STALE_MAX_AGE_SEC;
    const allowedGroupJids = config.WHATSAPP_ALLOWED_GROUP_JIDS
      ? config.WHATSAPP_ALLOWED_GROUP_JIDS.split(",").map((j) => j.trim()).filter(Boolean)
      : [];

    // Filter status updates and stale messages
    const nowSec = Math.floor(Date.now() / 1000);
    const notifications: typeof allNotifications = [];
    const staleDMs: typeof allNotifications = [];
    const statusUpdateIds: number[] = [];

    for (const n of allNotifications) {
      // Skip WhatsApp status updates (stories) — only real messages matter
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
      // Stale group messages are silently discarded
    }

    // Silently mark status updates as read
    if (statusUpdateIds.length > 0) {
      whatsappDB.markNotificationsRead(statusUpdateIds);
      for (const id of statusUpdateIds) processedIds.add(id);
    }

    // Notify about stale DMs
    const staleIds = allNotifications
      .filter((n) => !notifications.includes(n))
      .map((n) => n.id);
    if (staleIds.length > 0) {
      whatsappDB.markNotificationsRead(staleIds);
      for (const id of staleIds) processedIds.add(id);
      console.log(`[Proactive] Skipped ${staleIds.length} stale notifications (>${maxAgeSec}s old)`);
    }

    if (staleDMs.length > 0) {
      const senderNames = [...new Set(staleDMs.map((n) => n.sender_name || n.chat_jid.split("@")[0] || "?"))];
      const staleMsg = `<i>${staleDMs.length} eski WhatsApp mesaji atlandi: ${senderNames.map((s) => escapeHtml(s)).join(", ")}</i>`;
      await bot.api.sendMessage(userId, staleMsg, { parse_mode: "HTML" });
    }

    if (notifications.length === 0) return;

    // Separate DMs and group messages
    const dms = notifications.filter((n) => !n.is_group);
    const groupMsgs = notifications.filter((n) => n.is_group);

    const results: ProcessingResult[] = [];

    // --- DMs: Group by chat_jid, classify with Haiku ---
    if (dms.length > 0) {
      const bySender = new Map<string, typeof dms>();
      for (const notif of dms) {
        const key = notif.chat_jid;
        if (!bySender.has(key)) bySender.set(key, []);
        bySender.get(key)!.push(notif);
      }

      for (const [chatJid, msgs] of bySender) {
        try {
          // Process DM first — markReplied() must happen BEFORE signalBus.push()
          // to prevent Cortex from racing with the dedup check.
          const result = await handleDMMessages(msgs, chatJid, userId, config.WHATSAPP_MAX_REPLY_LENGTH);
          results.push(result);

          // Mark this chat's notification IDs as processed
          const chatIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(chatIds);
          for (const id of chatIds) processedIds.add(id);

          // Only push to Cortex Signal Bus if proactive did NOT already auto-reply.
          // If proactive replied (tier 1 + outboxSuccess), markReplied() is set and
          // Cortex would skip anyway — but not pushing avoids unnecessary pipeline work.
          const proactiveReplied = result.tier === 1 && result.outboxSuccess === true;
          if (!proactiveReplied && signalBus.isRunning()) {
            const senderName = msgs[0]?.sender_name || chatJid.split("@")[0] || "unknown";

            // Son 10 mesajı getir — Cortex'e konuşma bağlamı sağla
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
              conversationHistory, // Son 10 mesaj: ["Ben: ...", "Burak: ...", ...]
            }, { userId, contactId: chatJid });
          }
        } catch (chatError) {
          console.error(`[Proactive] Error processing DM chat ${chatJid}:`, chatError);
          // This chat's IDs remain in 'processing' — will be recovered on next cycle or startup
        }
      }
    }

    // --- Group messages: Group by chat_jid, check allowlist ---
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
          const result = await handleWatchedGroupMessages(msgs, userId, replyAllowed, config.WHATSAPP_MAX_REPLY_LENGTH);
          results.push(result);

          // Mark this group's notification IDs as processed
          const groupIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(groupIds);
          for (const id of groupIds) processedIds.add(id);
        } catch (groupError) {
          console.error(`[Proactive] Error processing group ${groupJid}:`, groupError);
          // This group's IDs remain in 'processing' — will be recovered on next cycle or startup
        }
      }
    }

    // Heartbeat with detailed metrics
    const tierCounts = { tier1: 0, tier2: 0, tier3: 0 };
    let outboxErrors = 0;
    for (const r of results) {
      if (r.tier === 1) tierCounts.tier1++;
      else if (r.tier === 2) tierCounts.tier2++;
      else tierCounts.tier3++;
      if (r.outboxSuccess === false) outboxErrors++;
    }

    heartbeat("whatsapp_notifications", {
      sent: notifications.length,
      dms: dms.length,
      groups: groupMsgs.length,
      stale: staleIds.length,
      ...tierCounts,
      outboxErrors,
      model: "haiku",
    });
  } catch (error) {
    console.error("[Proactive] WhatsApp notification check error:", error);
    // Only reset IDs that were NOT already successfully processed
    const unprocessedIds = allNotifications
      .map((n) => n.id)
      .filter((id) => !processedIds.has(id));
    if (unprocessedIds.length > 0) {
      whatsappDB.markNotificationsFailed(unprocessedIds);
    }
  }
}

/**
 * Handle incoming DMs with Haiku classification (2-stage LLM).
 * Tier 1: Auto-reply | Tier 2: Notify + suggest | Tier 3: Just notify
 */
export async function handleDMMessages(
  messages: ReturnType<typeof whatsappDB.getPendingNotifications>,
  chatJid: string,
  telegramUserId: number,
  maxReplyLength: number
): Promise<ProcessingResult> {
  if (!bot) return { model: "haiku", tier: 3, error: "bot_not_initialized" };

  const firstMsg = messages[0]!;
  const senderName = firstMsg.sender_name || chatJid.split("@")[0] || "?";
  const msgSummary = messages.map((m) => {
    const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
    return `${typeLabel}${sanitizeText(sanitizeForPrompt(m.content || ""), 500)}`;
  }).join("\n");

  try {
    const analysis = await classifyWhatsAppMessage(senderName, msgSummary, "dm") as TierClassification;

    // Check procedural memory — if rules exist for this scenario, escalate to full agent
    if (analysis.tier === 1 && analysis.reply) {
      // Idempotency: skip auto-reply if this chat was already replied to recently (e.g. retry after crash)
      if (wasRecentlyReplied(chatJid)) {
        console.log(`[Proactive] Skipping auto-reply to ${senderName} — already replied recently (dedup)`);
        await sendDMNotification(messages, senderName, telegramUserId);
        return { model: "haiku", tier: 3, error: "dedup_skipped" };
      }
      try {
        const userFolder = userManager.getUserFolder(telegramUserId);
        const memory = new SmartMemory(userFolder, telegramUserId);
        const procedures = await memory.search(msgSummary, { type: "procedural", limit: 2, minScore: 0.5 });
        memory.close();

        if (procedures.length > 0) {
          console.log(`[Proactive] Procedural memory match for DM from ${senderName} (${procedures.length} rules), escalating to full agent`);
          const fullResponse = await think(telegramUserId, `[WhatsApp DM - ${senderName}] ${msgSummary}`, "whatsapp");
          const reply = fullResponse.content.slice(0, maxReplyLength);
          const outboxOk = whatsappDB.addToOutbox(chatJid, reply);
          if (outboxOk) markReplied(chatJid);

          const notifyMsg = `<b>WhatsApp - ${escapeHtml(senderName)}</b> 🧠\n\n` +
            messages.map(m => {
              const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
              return `${typeLabel}${escapeHtml((m.content || "").slice(0, 80))}`;
            }).join("\n") +
            `\n\n<i>Akıllı cevap: "${escapeHtml(reply.slice(0, 200))}"</i>` +
            (!outboxOk ? `\n<b>Outbox hatasi!</b>` : "");

          await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });

          if (appConfig.FF_SESSION_STATE) {
            addWhatsAppNotification(telegramUserId, {
              senderName, chatJid,
              preview: (messages[0]?.content || "").slice(0, 100),
              tier: 1, autoReply: reply,
              isGroup: false, timestamp: Date.now(),
            });
          }

          // Create expectation for reply tracking (skip if one already exists for this target)
          if (outboxOk) {
            const existing = expectations.pending().find(e => e.target === chatJid && e.type === "whatsapp_reply");
            if (!existing) {
              expectations.create({
                type: "whatsapp_reply",
                target: chatJid,
                context: `Auto-reply sent to ${senderName}: "${reply.slice(0, 100)}"`,
                onResolved: `${senderName} replied to auto-message`,
                userId: telegramUserId,
                timeout: appConfig.CORTEX_EXPECTATION_TIMEOUT_MS,
              });
            }
          }

          return { model: "claude", tier: 1, outboxSuccess: outboxOk };
        }
      } catch (e) {
        console.error(`[Proactive] Procedural memory check failed:`, e);
      }

      const validation = validateReply(analysis.reply, maxReplyLength);
      if (!validation.valid) {
        console.log(`[Proactive] DM reply validation failed (${validation.reason}), downgrading to tier 3`);
        await sendDMNotification(messages, senderName, telegramUserId);
        return { model: "haiku", tier: 3, error: `validation_${validation.reason}` };
      }

      const outboxOk = whatsappDB.addToOutbox(chatJid, analysis.reply);
      if (outboxOk) markReplied(chatJid);

      const notifyMsg = `<b>WhatsApp - ${escapeHtml(senderName)}</b>\n\n` +
        messages.map(m => {
          const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
          return `${typeLabel}${escapeHtml((m.content || "").slice(0, 80))}`;
        }).join("\n") +
        `\n\n<i>Otomatik cevap: "${escapeHtml(analysis.reply)}"</i>` +
        (!outboxOk ? `\n<b>Outbox hatasi!</b>` : "");

      await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });
      console.log(`[Proactive] DM auto-replied to ${senderName}: ${analysis.reply}`);

      if (appConfig.FF_SESSION_STATE) {
        addWhatsAppNotification(telegramUserId, {
          senderName, chatJid,
          preview: (messages[0]?.content || "").slice(0, 100),
          tier: 1, autoReply: analysis.reply,
          isGroup: false, timestamp: Date.now(),
        });
      }

      // Create expectation for reply tracking (skip if one already exists for this target)
      if (outboxOk) {
        const existing = expectations.pending().find(e => e.target === chatJid && e.type === "whatsapp_reply");
        if (!existing) {
          expectations.create({
            type: "whatsapp_reply",
            target: chatJid,
            context: `Auto-reply sent to ${senderName}: "${analysis.reply.slice(0, 100)}"`,
            onResolved: `${senderName} replied to auto-message`,
            userId: telegramUserId,
            timeout: appConfig.CORTEX_EXPECTATION_TIMEOUT_MS,
          });
        }
      }

      return { model: "haiku", tier: 1, outboxSuccess: outboxOk };

    } else if (analysis.tier === 2 && analysis.suggestedReply) {
      const notifyMsg = `<b>WhatsApp - ${escapeHtml(senderName)}</b>\n\n` +
        messages.map(m => {
          const typeLabel = m.message_type !== "text" ? `[${m.message_type}] ` : "";
          return `${typeLabel}${escapeHtml((m.content || "").slice(0, 100))}`;
        }).join("\n") +
        `\n\n<b>Onerilen cevap:</b> <i>"${escapeHtml(analysis.suggestedReply)}"</i>` +
        `\n<i>${escapeHtml(analysis.reason || "")}</i>`;

      await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });

      if (appConfig.FF_SESSION_STATE) {
        addWhatsAppNotification(telegramUserId, {
          senderName, chatJid,
          preview: (messages[0]?.content || "").slice(0, 100),
          tier: 2, isGroup: false, timestamp: Date.now(),
        });
      }
      return { model: "haiku", tier: 2 };

    } else {
      await sendDMNotification(messages, senderName, telegramUserId);

      if (appConfig.FF_SESSION_STATE) {
        addWhatsAppNotification(telegramUserId, {
          senderName, chatJid,
          preview: (messages[0]?.content || "").slice(0, 100),
          tier: 3, isGroup: false, timestamp: Date.now(),
        });
      }
      return { model: "haiku", tier: 3 };
    }
  } catch (error) {
    console.error(`[Proactive] DM analysis error for ${senderName}:`, error);
    await sendDMNotification(messages, senderName, telegramUserId);
    return { model: "haiku", tier: 3, error: String(error) };
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
 * Analyze watched group messages with Haiku classification.
 * Respects allowlist: only groups in WHATSAPP_ALLOWED_GROUP_JIDS can receive auto-replies.
 */
export async function handleWatchedGroupMessages(
  messages: ReturnType<typeof whatsappDB.getPendingNotifications>,
  telegramUserId: number,
  replyAllowed: boolean,
  maxReplyLength: number
): Promise<ProcessingResult> {
  if (!bot) return { model: "haiku", tier: 3, error: "bot_not_initialized" };

  const firstMsg = messages[0]!;
  const groupJid = firstMsg.chat_jid;
  const groupName = firstMsg.sender_name?.split(" @ ")[1] || groupJid;

  const msgSummary = messages.map((m) => {
    const sender = (m.sender_name || "").split(" @ ")[0] || "?";
    return `[${sender}]: ${sanitizeText(sanitizeForPrompt(m.content || `[${m.message_type}]`), 500)}`;
  }).join("\n");

  try {
    const analysis = await classifyWhatsAppMessage("", msgSummary, "group", groupName) as GroupClassification;

    if (replyAllowed && analysis.shouldReply && analysis.reply) {
      const validation = validateReply(analysis.reply, maxReplyLength);
      if (!validation.valid) {
        console.log(`[Proactive] Group reply validation failed (${validation.reason}), skipping reply`);
        await sendGroupNotification(messages, groupName, telegramUserId, analysis.reason);
        return { model: "haiku", tier: 3, error: `validation_${validation.reason}` };
      }

      const outboxOk = whatsappDB.addToOutbox(groupJid, analysis.reply);

      const notifyMsg = `<b>WhatsApp - ${escapeHtml(groupName)}</b>\n\n` +
        messages.map(m => {
          const sender = (m.sender_name || "").split(" @ ")[0] || "?";
          return `<b>${escapeHtml(sender)}</b>: ${escapeHtml((m.content || "").slice(0, 80))}`;
        }).join("\n") +
        `\n\n<i>Otomatik cevap gonderdim: "${escapeHtml(analysis.reply)}"</i>` +
        `\n<i>Sebep: ${escapeHtml(analysis.reason || "")}</i>` +
        (!outboxOk ? `\n<b>Outbox hatasi!</b>` : "");

      await bot.api.sendMessage(telegramUserId, notifyMsg, { parse_mode: "HTML" });
      console.log(`[Proactive] Auto-replied to ${groupName}: ${analysis.reply}`);

      if (appConfig.FF_SESSION_STATE) {
        addWhatsAppNotification(telegramUserId, {
          senderName: groupName, chatJid: groupJid,
          preview: msgSummary.slice(0, 100),
          tier: 1, autoReply: analysis.reply,
          isGroup: true, timestamp: Date.now(),
        });
      }
      return { model: "haiku", tier: 1, outboxSuccess: outboxOk };
    } else {
      if (!replyAllowed && analysis.shouldReply) {
        console.log(`[Proactive] Group ${groupJid} not in allowlist, skipping reply`);
      }
      await sendGroupNotification(messages, groupName, telegramUserId, analysis.reason);

      if (appConfig.FF_SESSION_STATE) {
        addWhatsAppNotification(telegramUserId, {
          senderName: groupName, chatJid: groupJid,
          preview: msgSummary.slice(0, 100),
          tier: 3, isGroup: true, timestamp: Date.now(),
        });
      }
      return { model: "haiku", tier: 3 };
    }
  } catch (error) {
    console.error("[Proactive] Group message analysis error:", error);
    await sendGroupNotification(messages, groupName, telegramUserId);
    return { model: "haiku", tier: 3, error: String(error) };
  }
}

/** Simple group notification (fallback / no-reply) */
async function sendGroupNotification(
  messages: ReturnType<typeof whatsappDB.getPendingNotifications>,
  groupName: string,
  telegramUserId: number,
  reason?: string
): Promise<void> {
  if (!bot) return;

  let message = `<b>WhatsApp - ${escapeHtml(groupName)}</b>\n\n`;
  for (const m of messages) {
    const sender = (m.sender_name || "").split(" @ ")[0] || "?";
    message += `<b>${escapeHtml(sender)}</b>: ${escapeHtml((m.content || "").slice(0, 100))}\n`;
  }
  if (reason) {
    message += `\n<i>${escapeHtml(reason)}</i>`;
  }
  await bot.api.sendMessage(telegramUserId, message, { parse_mode: "HTML" });
}


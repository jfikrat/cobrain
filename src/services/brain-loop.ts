/**
 * BrainLoop — Unified autonomous loop (Cortex direct edition)
 *
 * Architecture:
 * - fastTick (30s): WhatsApp poll → inbox, due reminders → inbox
 * - slowTick (5min): periodic check → inbox, code review cycle
 *
 * All AI reasoning is handled by Cortex (Sonnet) directly via inbox.
 * Stem (Haiku triage) layer has been removed.
 */

import { resolve, join } from "node:path";
import { Bot } from "grammy";
import { config } from "../config.ts";
import { userManager } from "./user-manager.ts";
import { getRemindersService } from "./reminders.ts";
import { FileMemory } from "../memory/file-memory.ts";
import { getSessionState, updateSessionState } from "./session-state.ts";
import { expectations } from "./expectations.ts";
import { heartbeat } from "./heartbeat.ts";
import { whatsappDB } from "./whatsapp-db.ts";
import { getTaskQueue } from "./task-queue.ts";
import { escapeHtml } from "../utils/escape-html.ts";
import { chat, isUserBusy } from "../agent/chat.ts";
import { mneme } from "../mneme/mneme.ts";
import { inbox } from "./inbox.ts";
import { markReplied, wasRecentlyReplied } from "./reply-dedup.ts";
import { waMailbox } from "./wa-mailbox.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

async function sendLogToChannel(bot: Bot, eventType: string, response: Awaited<ReturnType<typeof chat>>): Promise<void> {
  if (!config.LOG_CHANNEL_ID) return;
  try {
    const tools = response.toolsUsed.length > 0 ? response.toolsUsed.join(", ") : "—";
    const preview = response.content.slice(0, 300).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const msg = `🤖 <b>${eventType}</b>\n\n${preview}${response.content.length > 300 ? "…" : ""}\n\n🔧 <code>${tools}</code> | 💰 $${response.totalCost.toFixed(4)} | 🔄 ${response.numTurns} turn`;
    await bot.api.sendMessage(config.LOG_CHANNEL_ID, msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[BrainLoop] Log channel send failed:", err);
  }
}

async function sendRawLog(bot: Bot, msg: string): Promise<void> {
  if (!config.LOG_CHANNEL_ID) return;
  try {
    await bot.api.sendMessage(config.LOG_CHANNEL_ID, msg, { parse_mode: "HTML" });
  } catch (err) {
    console.error("[BrainLoop] Log channel send failed:", err);
  }
}

// ── Constants ────────────────────────────────────────────────────────────

const FAST_TICK_MS = config.BRAIN_LOOP_FAST_TICK_MS;
const SLOW_TICK_MS = config.BRAIN_LOOP_SLOW_TICK_MS;

const CODE_REVIEW_FILES = [
  "src/agent/chat.ts",
  "src/services/brain-loop.ts",
  "src/brain/index.ts",
  "src/memory/file-memory.ts",
  "src/channels/telegram.ts",
  "src/agent/prompts.ts",
  "src/brain/event-store.ts",
  "src/services/scheduler.ts",
  "src/services/task-queue.ts",
  "src/config.ts",
];

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20250121";
const PROJECT_ROOT = resolve(import.meta.dir, "../..");

// ── BrainLoop Class ──────────────────────────────────────────────────────

class BrainLoop {
  private bot: Bot | null = null;
  private fastIntervalId: ReturnType<typeof setInterval> | null = null;
  private slowIntervalId: ReturnType<typeof setInterval> | null = null;
  private codeReviewIndex = 0;
  private lastCodeReviewDate: string | null = null;
  private lastProactiveCheckHour: string | null = null;
  // Timestamp-based scan: chatJid → son görülen mesajın unix timestamp'i (sn)
  private lastSeenMsgTimestamps = new Map<string, number>();

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(botInstance: Bot): void {
    this.bot = botInstance;
    if (!config.MINIMAL_AUTONOMY) {
      this.restoreState();
    }

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
    if (!config.MINIMAL_AUTONOMY) {
      this.persistState();
    }
    console.log("[BrainLoop] Stopped");
  }

  // ── Fast Tick (30s) ─────────────────────────────────────────────────

  private async fastTick(): Promise<void> {
    heartbeat("brain_loop", { event: "fast_tick" });

    let processedJids = new Set<string>();
    try {
      processedJids = await this.pollWhatsApp();
    } catch (err) {
      console.error("[BrainLoop] pollWhatsApp error:", err);
    }

    try {
      await this.timestampScanWhatsApp(processedJids);
    } catch (err) {
      console.error("[BrainLoop] timestampScanWhatsApp error:", err);
    }

    try {
      await this.checkDueReminders();
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }

    try {
      await this.processInbox();
    } catch (err) {
      console.error("[BrainLoop] processInbox error:", err);
    }
  }

  // ── Slow Tick (5min) ────────────────────────────────────────────────

  private async slowTick(): Promise<void> {
    heartbeat("brain_loop", { event: "slow_tick" });

    // Mneme: memory consolidation during sleep hours (03:00-03:59)
    if (mneme.shouldRun() && this.bot) {
      mneme.run(config.MY_TELEGRAM_ID, this.bot).catch(err =>
        console.error("[BrainLoop] mneme error:", err)
      );
    }

    try {
      await this.checkExpiredExpectations();
    } catch (err) {
      console.error("[BrainLoop] checkExpiredExpectations error:", err);
    }

    try {
      await this.checkProactiveBehaviors();
    } catch (err) {
      console.error("[BrainLoop] checkProactiveBehaviors error:", err);
    }

    // Code review cycle is disabled in minimal autonomy mode.
    if (!config.MINIMAL_AUTONOMY) {
      try {
        await this.maybeRunCodeReview(config.MY_TELEGRAM_ID);
      } catch (err) {
        console.error("[BrainLoop] maybeRunCodeReview error:", err);
      }

      this.persistState();
    }
  }

  // ── WhatsApp Polling → Inbox (Cortex direct) ─────────────────────────

  private async pollWhatsApp(): Promise<Set<string>> {
    const processedJids = new Set<string>();
    if (!this.bot || !whatsappDB.isAvailable()) return processedJids;

    const allNotifications = whatsappDB.getPendingNotifications(10);
    if (allNotifications.length === 0) {
      heartbeat("whatsapp_notifications", { sent: 0, dms: 0, groups: 0, stale: 0 });
      return processedJids;
    }

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

    if (notifications.length === 0) return processedJids;

    const dms = notifications.filter(n => !n.is_group);
    const groupMsgs = notifications.filter(n => n.is_group);

    // ── Feed DMs → Inbox (Cortex direct) ──────────────────────────────
    if (dms.length > 0) {
      const bySender = new Map<string, typeof dms>();
      for (const notif of dms) {
        const key = notif.chat_jid;
        if (!bySender.has(key)) bySender.set(key, []);
        bySender.get(key)!.push(notif);
      }

      for (const [chatJid, msgs] of bySender) {
        const senderName = msgs[0]!.sender_name || chatJid.split("@")[0] || "?";
        try {
          // Guard 1: Son 60s içinde bu chat'e cevap verildiyse atla
          if (wasRecentlyReplied(chatJid)) {
            const chatIds = msgs.map(m => m.id);
            whatsappDB.markNotificationsRead(chatIds);
            processedJids.add(chatJid);
            console.log(`[BrainLoop] WA DM skip (dedup): ${senderName}`);
            continue;
          }

          // Guard 2: Inbox'ta bu chat için zaten item varsa atla (processAfter bekleyenler dahil)
          const alreadyPending = inbox.hasChatItem(chatJid);
          if (alreadyPending) {
            const chatIds = msgs.map(m => m.id);
            whatsappDB.markNotificationsRead(chatIds);
            processedJids.add(chatJid);
            console.log(`[BrainLoop] WA DM skip (pending): ${senderName}`);
            continue;
          }

          // Guard 3: Son 120s içinde Fekrat bu chat'e cevap yazdıysa atla
          const recentOutgoing = whatsappDB.getRecentOutgoing(chatJid, nowSec - 120);
          if (recentOutgoing.length > 0) {
            const chatIds = msgs.map(m => m.id);
            whatsappDB.markNotificationsRead(chatIds);
            processedJids.add(chatJid);
            console.log(`[BrainLoop] WA DM skip (user replied): ${senderName}`);
            continue;
          }

          // Bekleyen whatsapp_reply expectation var mı? → resolve et
          const pendingExp = expectations
            .pendingForUser(userId)
            .find(e => e.target === chatJid && e.type === "whatsapp_reply");
          if (pendingExp) {
            const replyContent = msgs.map(m => m.content || "[medya]").join("\n");
            await expectations.resolve(pendingExp.id, { reply: replyContent.slice(0, 200) });
            console.log(`[BrainLoop] Expectation resolved: whatsapp_reply from ${senderName}`);
          }

          const incomingMsgs = msgs.map(m => ({
            content: m.content || (m.media_path ? `[medya: ${m.media_path}]` : "[medya]"),
            message_type: m.message_type || "text",
          }));

          // Outgoing mesajları (Fekrat'ın gönderdiği) history'e ekle
          const lastOutTs = waMailbox.getLastOutgoingTimestamp(chatJid);
          const sinceTs = lastOutTs > 0
            ? Math.floor(lastOutTs / 1000)
            : Math.floor(Date.now() / 1000) - 3600; // İlk kez: son 1 saat
          const outgoingMsgs = whatsappDB.getRecentOutgoing(chatJid, sinceTs);
          for (const msg of outgoingMsgs) {
            waMailbox.addOutgoing(chatJid, msg.content || "[medya]", (msg.timestamp || 0) * 1000);
          }

          waMailbox.push(chatJid, senderName, incomingMsgs);
          const history = waMailbox.getHistory(chatJid);
          const msgTexts = incomingMsgs.map(m => m.content).join("\n");

          // chatJid'i body'ye ekle — doğru numaraya cevap yazabilmek için
          const bodyParts = [`Bağlam: [whatsapp_dm] ${senderName} | jid:${chatJid}: ${msgTexts}`];
          if (history.length > 0) {
            const historyStr = history.map(m => `[${m.direction === "incoming" ? "←" : "→"}] ${m.content}`).join("\n");
            bodyParts.push(`[SON MESAJLAR]\n${historyStr}`);
          }

          await inbox.push({
            from: "brain-loop",
            subject: `[whatsapp_dm] ${senderName}: ${incomingMsgs[0]?.content?.slice(0, 80) ?? ""}`,
            body: bodyParts.join("\n\n"),
            priority: "normal",
            ttlMs: 2 * 60 * 60 * 1000,
            chatJid,
            processAfter: Date.now() + 60_000, // 60s bekle — Fekrat arada cevap verirse Guard 3 yakalar
            cortex: "wa",
          });
          waMailbox.markProcessed(chatJid);
          processedJids.add(chatJid);
          console.log(`[BrainLoop] WA DM → Inbox: ${senderName} (processAfter: 60s, cortex: wa)`);

          // lastSeenMsgTimestamps güncelle — timestamp scan duplikasyon yapmaz
          const maxMsgTs = Math.max(...msgs.map(m => m.message_timestamp || 0));
          if (maxMsgTs > 0) {
            const cur = this.lastSeenMsgTimestamps.get(chatJid) ?? 0;
            if (maxMsgTs > cur) this.lastSeenMsgTimestamps.set(chatJid, maxMsgTs);
          }

          const chatIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(chatIds);
          for (const id of chatIds) processedIds.add(id);
        } catch (chatError) {
          console.error(`[BrainLoop] DM ${chatJid} error:`, chatError);
          if (this.bot) await sendRawLog(this.bot, `❌ <b>WA DM hata</b> — ${escapeHtml(senderName)}\n<code>${String(chatError).slice(0, 200)}</code>`);
        }
      }
    }

    // ── Feed Group Messages → Inbox (Cortex direct) ────────────────────
    if (groupMsgs.length > 0) {
      const byGroup = new Map<string, typeof groupMsgs>();
      for (const notif of groupMsgs) {
        const key = notif.chat_jid;
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(notif);
      }

      for (const [groupJid, msgs] of byGroup) {
        const groupName = msgs[0]!.sender_name?.split(" @ ")[1] || groupJid;
        try {
          const replyAllowed = allowedGroupJids.length > 0 && allowedGroupJids.includes(groupJid);
          const msgTexts = msgs.map(m => `${m.sender_name || "?"}: ${m.content || "[medya]"}`).join("\n");

          await inbox.push({
            from: "brain-loop",
            subject: `[whatsapp_group] ${groupName}`,
            body: `Bağlam: [whatsapp_group] ${groupName}\nCevap izni: ${replyAllowed ? "evet" : "hayır"}\n\n${msgTexts}`,
            priority: "normal",
            ttlMs: 2 * 60 * 60 * 1000,
          });
          console.log(`[BrainLoop] WA Grup → Inbox: ${groupName}`);

          const groupIds = msgs.map(m => m.id);
          whatsappDB.markNotificationsRead(groupIds);
          for (const id of groupIds) processedIds.add(id);
        } catch (groupError) {
          console.error(`[BrainLoop] Group ${groupJid} error:`, groupError);
          if (this.bot) await sendRawLog(this.bot, `❌ <b>WA Grup hata</b> — ${escapeHtml(groupName)}\n<code>${String(groupError).slice(0, 200)}</code>`);
        }
      }
    }

    heartbeat("whatsapp_notifications", {
      sent: notifications.length,
      dms: dms.length,
      groups: groupMsgs.length,
      stale: staleIds.length,
    });

    return processedJids;
  }

  // ── Timestamp-based WhatsApp Scan ─────────────────────────────────────
  // notifications tablosuna güvenmez — messages tablosunu timestamp ile tarar.
  // Fekrat telefonda okusa bile mesajı yakalar.

  private async timestampScanWhatsApp(skipJids: Set<string>): Promise<void> {
    if (!whatsappDB.isAvailable()) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const activeChats = whatsappDB.getRecentActiveChats(1); // son 1 saat

    for (const { chatJid, senderName } of activeChats) {
      if (skipJids.has(chatJid)) continue; // notifications path'i zaten işledi

      const lastSeen = this.lastSeenMsgTimestamps.get(chatJid);
      if (lastSeen === undefined) {
        // İlk kez görülen chat — baseline'ı şu ana ayarla, bu tick'te işleme
        this.lastSeenMsgTimestamps.set(chatJid, nowSec);
        continue;
      }

      const newMsgs = whatsappDB.getRecentIncoming(chatJid, lastSeen);
      if (newMsgs.length === 0) continue;

      // lastSeen'i güncelle — sonraki tick'te tekrar işleme
      const newestTs = Math.max(...newMsgs.map(m => m.timestamp ?? 0));
      if (newestTs > lastSeen) this.lastSeenMsgTimestamps.set(chatJid, newestTs);

      // Guard 1: Son 60s içinde bu chat'e cevap verildiyse atla
      if (wasRecentlyReplied(chatJid)) {
        console.log(`[BrainLoop] WA ts-scan skip (dedup): ${senderName}`);
        continue;
      }

      // Guard 2: Inbox'ta bu chat için zaten item varsa atla (processAfter bekleyenler dahil)
      if (inbox.hasChatItem(chatJid)) {
        console.log(`[BrainLoop] WA ts-scan skip (pending): ${senderName}`);
        continue;
      }

      // Guard 3: Son 120s içinde Fekrat bu chat'e cevap yazdıysa atla
      if (whatsappDB.getRecentOutgoing(chatJid, nowSec - 120).length > 0) {
        console.log(`[BrainLoop] WA ts-scan skip (user replied): ${senderName}`);
        continue;
      }

      try {
        const incomingMsgs = newMsgs.map(m => ({
          content: m.content || (m.message_type !== "text" ? `[${m.message_type}]` : "[mesaj]"),
          message_type: m.message_type || "text",
        }));

        // Outgoing history'yi de sync et
        const lastOutTs = waMailbox.getLastOutgoingTimestamp(chatJid);
        const sinceTs = lastOutTs > 0 ? Math.floor(lastOutTs / 1000) : nowSec - 3600;
        const outgoing = whatsappDB.getRecentOutgoing(chatJid, sinceTs);
        for (const msg of outgoing) {
          waMailbox.addOutgoing(chatJid, msg.content || "[medya]", (msg.timestamp || 0) * 1000);
        }

        waMailbox.push(chatJid, senderName, incomingMsgs);
        const history = waMailbox.getHistory(chatJid);
        const msgTexts = incomingMsgs.map(m => m.content).join("\n");

        const bodyParts = [`Bağlam: [whatsapp_dm] ${senderName} | jid:${chatJid}: ${msgTexts}`];
        if (history.length > 0) {
          const historyStr = history.map(m => `[${m.direction === "incoming" ? "←" : "→"}] ${m.content}`).join("\n");
          bodyParts.push(`[SON MESAJLAR]\n${historyStr}`);
        }

        await inbox.push({
          from: "brain-loop",
          subject: `[whatsapp_dm] ${senderName}: ${incomingMsgs[0]?.content?.slice(0, 80) ?? ""}`,
          body: bodyParts.join("\n\n"),
          priority: "normal",
          ttlMs: 2 * 60 * 60 * 1000,
          chatJid,
          processAfter: Date.now() + 60_000, // 60s bekle — Fekrat arada cevap verirse Guard 3 yakalar
          cortex: "wa",
        });
        waMailbox.markProcessed(chatJid);
        console.log(`[BrainLoop] WA DM (ts-scan) → Inbox: ${senderName} (${newMsgs.length} msg, processAfter: 60s, cortex: wa)`);
      } catch (err) {
        console.error(`[BrainLoop] timestampScan ${chatJid} error:`, err);
      }
    }
  }

  // ── Due Reminders → Inbox ────────────────────────────────────────────

  private async checkDueReminders(): Promise<void> {
    const userId = config.MY_TELEGRAM_ID;

    try {
      const db = await userManager.getUserDb(userId);
      const remindersService = await getRemindersService(db, userId);
      const dueReminders = remindersService.getDueReminders();

      for (const reminder of dueReminders) {
        try {
          await inbox.push({
            from: "brain-loop",
            subject: `[hatırlatıcı] ${reminder.title}`,
            body: `[OTONOM OLAY — Hatırlatıcı]\n${reminder.title}${reminder.message ? `\n${reminder.message}` : ""}`,
            priority: "urgent",
            ttlMs: 30 * 60 * 1000,
          });
          console.log(`[BrainLoop] Hatırlatıcı → Inbox: ${reminder.title}`);
        } catch (err) {
          console.error("[BrainLoop] reminder error:", err);
          if (this.bot) await sendRawLog(this.bot, `❌ <b>Hatırlatıcı hata</b> — ${escapeHtml(reminder.title)}\n<code>${String(err).slice(0, 200)}</code>`);
        }
        // Başarı veya hata — mark et (hata durumunda sonsuz döngüyü önle)
        remindersService.markReminderSent(reminder.id);
      }
    } catch (err) {
      console.error("[BrainLoop] checkDueReminders error:", err);
    }
  }

  // ── Expired Expectations → Inbox ─────────────────────────────────────

  private async checkExpiredExpectations(): Promise<void> {
    const expired = expectations.cleanExpired();
    if (expired.length === 0) return;

    for (const exp of expired) {
      await inbox.push({
        from: "brain-loop",
        subject: `[beklenti_timeout] ${exp.type} — ${exp.target}`,
        body: `Beklenti zaman aşımına uğradı:\nTür: ${exp.type}\nHedef: ${exp.target}\nBağlam: ${exp.context || "yok"}\nOnResolved: ${exp.onResolved || "yok"}`,
        priority: "normal",
        ttlMs: 60 * 60 * 1000,
      });
      console.log(`[BrainLoop] Expectation timeout → Inbox: [${exp.type}] ${exp.target}`);
    }
  }

  // ── Proactive Behaviors Check ─────────────────────────────────────────
  //
  // Saatte bir, aktif saatlerde (07-23) Cortex'e "behaviors.md'ini kontrol et"
  // mesajı gönderir. Hangi davranışın ne zaman çalışacağı tamamen behaviors.md'de
  // tanımlı — bu kod sadece tetikleyicidir, hiçbir davranış hardcode değil.

  private async checkProactiveBehaviors(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();

    // Sadece aktif saatlerde (07:00-23:00)
    if (hour < 7 || hour >= 23) return;

    // Saatte bir kez
    const hourKey = `${now.toISOString().slice(0, 10)}-${String(hour).padStart(2, "0")}`;
    if (this.lastProactiveCheckHour === hourKey) return;

    this.lastProactiveCheckHour = hourKey;

    const dayNames = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
    const dayName = dayNames[now.getDay()];
    const timeStr = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateStr = now.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });

    await inbox.push({
      from: "scheduler",
      subject: `Proaktif kontrol — ${timeStr}`,
      body: `Saat: ${timeStr} (${dayName}, ${dateStr})\n\nbehaviors.md'ini oku. Şu an yapman gereken proaktif bir şey var mı?\n\nEvet → yap ve gerekirse Telegram'a bildir.\nHayır → sessiz kal, bu mesajı işaretlenmiş say.`,
      priority: "normal",
      ttlMs: 55 * 60 * 1000, // 55 dakikada expire — bir sonraki tick'te yenisi gelir
    });

    console.log(`[BrainLoop] Proactive check pushed: ${hourKey}`);
  }

  // ── Inbox Processing ─────────────────────────────────────────────────

  private async processInbox(): Promise<void> {
    const pendingItem = inbox.pending()[0];
    if (!pendingItem) return;

    // WA Cortex: kullanıcı meşgul olsa bile bağımsız çalışır
    if (pendingItem.cortex === "wa") {
      await inbox.markProcessed(pendingItem.id);
      this.processWACortexItem(pendingItem).catch(err =>
        console.error("[BrainLoop] WA cortex error:", err)
      );
      return;
    }

    // Ana Cobrain: kullanıcı konuşuyorsa bekle
    if (isUserBusy(config.MY_TELEGRAM_ID)) return;

    const prompt = [
      `[GELEN KUTUSU — ${pendingItem.from.toUpperCase()}]`,
      `Konu: ${pendingItem.subject}`,
      ``,
      pendingItem.body,
    ].join("\n");

    console.log(`[BrainLoop] Inbox item işleniyor: "${pendingItem.subject}"`);

    // Kullanıcıya "çalışıyor" göster — her 4s yenile
    const userId = config.MY_TELEGRAM_ID;
    if (this.bot) this.bot.api.sendChatAction(userId, "typing").catch(() => {});
    const typingInterval = this.bot
      ? setInterval(() => this.bot!.api.sendChatAction(userId, "typing").catch(() => {}), 4000)
      : null;

    chat(userId, prompt)
      .then(async response => {
        if (typingInterval) clearInterval(typingInterval);
        await inbox.markProcessed(pendingItem.id);
        // WA DM ise cevap verildi olarak işaretle — 60s dedup
        if (pendingItem.chatJid) markReplied(pendingItem.chatJid);
        if (this.bot) sendLogToChannel(this.bot, `📬 Inbox [${pendingItem.from}] — ${pendingItem.subject.slice(0, 60)}`, response);
      })
      .catch(err => {
        if (typingInterval) clearInterval(typingInterval);
        console.error("[BrainLoop] Inbox işleme hatası:", err);
      });
  }

  // ── WA Cortex Processor ───────────────────────────────────────────────

  private async processWACortexItem(item: import("./inbox.ts").InboxItem): Promise<void> {
    const userId = config.MY_TELEGRAM_ID;
    const userFolder = userManager.getUserFolder(userId);
    const systemPromptPath = join(userFolder, "mind/cortexes/wa/system-prompt.md");

    let systemPromptOverride: string | undefined;
    try {
      systemPromptOverride = await Bun.file(systemPromptPath).text();
    } catch {
      console.warn("[BrainLoop] WA cortex system-prompt yüklenemedi, ana Cobrain ile işlenecek");
    }

    const prompt = [
      `[GELEN KUTUSU — WA-CORTEX]`,
      `Konu: ${item.subject}`,
      ``,
      item.body,
    ].join("\n");

    console.log(`[BrainLoop] WA Cortex işleniyor: "${item.subject}"`);

    try {
      const response = await chat(userId, prompt, undefined, undefined, {
        systemPromptOverride,
        sessionKey: "wa_cortex",
      });

      console.log(`[BrainLoop] WA Cortex tamamlandı: ${response.numTurns} turn, $${response.totalCost.toFixed(4)}`);

      // WA DM ise cevap verildi olarak işaretle — 60s dedup
      if (item.chatJid) {
        markReplied(item.chatJid);

        // Cortex'in gönderdiği mesajları waMailbox'a sync et
        // 5s bekle — Baileys DB'ye yazma gecikmesi için
        const chatJid = item.chatJid;
        setTimeout(() => {
          const nowSec = Math.floor(Date.now() / 1000);
          const recentOutgoing = whatsappDB.getRecentOutgoing(chatJid, nowSec - 60);
          for (const msg of recentOutgoing) {
            waMailbox.addOutgoing(chatJid, msg.content || "[medya]", (msg.timestamp || 0) * 1000);
          }
          if (recentOutgoing.length > 0) {
            console.log(`[BrainLoop] WA Cortex outgoing synced: ${recentOutgoing.length} msg → waMailbox`);
          }
        }, 5000);
      }

      // Outbox kontrol et — Cobrain onayı gerekiyor mu?
      await this.checkWACortexOutbox(userId, userFolder);

      if (this.bot) {
        sendLogToChannel(this.bot, `💬 WA Cortex — ${item.subject.slice(0, 60)}`, response);
      }
    } catch (err) {
      console.error("[BrainLoop] WA Cortex chat error:", err);
      if (this.bot) {
        await sendRawLog(this.bot, `❌ <b>WA Cortex hata</b>\n<code>${String(err).slice(0, 200)}</code>`);
      }
    }
  }

  private async checkWACortexOutbox(userId: number, userFolder: string): Promise<void> {
    const outboxPath = join(userFolder, "mind/cortexes/wa/outbox.md");
    try {
      const content = await Bun.file(outboxPath).text();
      if (!content.includes("Cobrain Onayı Gerekiyor")) return;

      // Son session'ın ## başlığından itibaren olan kısmı al
      const sections = content.split(/^(?=## \[)/m);
      const lastSection = sections[sections.length - 1] ?? "";

      if (!lastSection.includes("Cobrain Onayı Gerekiyor")) return;

      const match = lastSection.match(/### Cobrain Onayı Gerekiyor\n([\s\S]*?)(?=\n###|$)/);
      const approvalText = match?.[1]?.trim();
      if (!approvalText) return;

      if (this.bot) {
        await this.bot.api.sendMessage(
          userId,
          `📬 <b>WA Cortex onay bekliyor:</b>\n\n${escapeHtml(approvalText.slice(0, 800))}`,
          { parse_mode: "HTML" },
        );
      }
    } catch {
      // outbox.md yoksa sessiz kal
    }
  }

  // ── Code Review Cycle ──────────────────────────────────────────────

  private async maybeRunCodeReview(userId: number): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().slice(0, 10);

    if (hour !== 14) return;
    if (this.lastCodeReviewDate === today) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const filePath = CODE_REVIEW_FILES[this.codeReviewIndex % CODE_REVIEW_FILES.length]!;
    this.codeReviewIndex++;
    this.lastCodeReviewDate = today;

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
      const fileMemory = new FileMemory(userFolder);
      const highPriorityBugs: string[] = [];

      for (const obs of observations) {
        const entry = `[code-obs] [${obs.type}/${obs.priority}] ${filePath}: ${obs.observation} → ${obs.suggestion}`;
        await fileMemory.logEvent(entry);

        if (obs.priority === "high" && obs.type === "bug") {
          highPriorityBugs.push(`${filePath}: ${obs.observation}`);
        }
      }

      console.log(`[BrainLoop:CodeReview] ${observations.length} observation(s) saved for ${filePath}`);

      if (highPriorityBugs.length > 0 && this.bot) {
        const bugMsg = highPriorityBugs.map(b => `- ${b}`).join("\n");
        await this.bot.api.sendMessage(
          userId,
          `Code review'da yüksek öncelikli bug buldum:\n${bugMsg}\n\nDetay: recall("code-obs") ile bakabilirsin.`,
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
      this.lastProactiveCheckHour = state.lastProactiveCheckHour ?? null;
      // lastSeenMsgTimestamps'i session state'den geri yükle
      if (state.lastSeenMsgTimestamps) {
        for (const [jid, ts] of Object.entries(state.lastSeenMsgTimestamps)) {
          this.lastSeenMsgTimestamps.set(jid, ts);
        }
        console.log(`[BrainLoop] lastSeenMsgTimestamps restored: ${this.lastSeenMsgTimestamps.size} chat(s)`);
      }
      console.log(`[BrainLoop] State restored: codeReviewIdx=${this.codeReviewIndex}`);
    } catch (err) {
      console.warn("[BrainLoop] State restore failed:", err);
    }

    // WaMailbox seed — restart sonrası son 24 saatte aktif DM geçmişini yükle
    if (whatsappDB.isAvailable()) {
      try {
        const activeChats = whatsappDB.getRecentActiveChats(24);
        for (const chat of activeChats) {
          const messages = whatsappDB.getMessages(chat.chatJid, 15);
          waMailbox.seedFromHistory(chat.chatJid, chat.senderName, messages);
          // lastSeenMsgTimestamps: session state'den gelen değer varsa koru, yoksa DB'den seed et
          if (!this.lastSeenMsgTimestamps.has(chat.chatJid)) {
            const newestMsg = messages[messages.length - 1];
            if (newestMsg?.timestamp) {
              this.lastSeenMsgTimestamps.set(chat.chatJid, newestMsg.timestamp);
            }
          }
        }
        console.log(`[BrainLoop] WaMailbox seeded for ${activeChats.length} chat(s)`);
      } catch (err) {
        console.warn("[BrainLoop] WaMailbox seed failed:", err);
      }
    }
  }

  private persistState(): void {
    try {
      updateSessionState(config.MY_TELEGRAM_ID, {
        codeReviewIndex: this.codeReviewIndex,
        lastCodeReviewDate: this.lastCodeReviewDate,
        lastProactiveCheckHour: this.lastProactiveCheckHour,
        lastSeenMsgTimestamps: Object.fromEntries(this.lastSeenMsgTimestamps),
      });
    } catch (err) {
      console.warn("[BrainLoop] State persist failed:", err);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────

export const brainLoop = new BrainLoop();

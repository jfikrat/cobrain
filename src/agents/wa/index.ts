/**
 * WA Agent — Bağımsız WhatsApp İletişim Process'i
 *
 * Cobrain'den bağımsız process olarak çalışır:
 * - Kendi WhatsApp DB poll loop'u (30s)
 * - DM + Grup mesajları işleme (tek sahip)
 * - AI inference: Kendi Agent SDK instance'ı (HTTP bağımlılığı yok)
 * - Doğrudan WA DB outbox'a mesaj yazma (proxy yok)
 * - Kendi mini HTTP server (Cobrain'den görev alır)
 * - Her chat için izole session (sessionKey: wa_<chatJid>)
 *
 * Başlatma: bun run src/agents/wa/index.ts
 * Cobrain startup.ts üzerinden Bun.spawn() ile de başlatılır.
 */

import { Database } from "bun:sqlite";
import { waChat } from "./chat.ts";

// ── Config ───────────────────────────────────────────────────────────────

const API_KEY = process.env.COBRAIN_API_KEY || "";
const AGENT_PORT = parseInt(process.env.WA_AGENT_PORT || "3001");
const POLL_INTERVAL_MS = 10_000;
const MAX_AGE_SEC = parseInt(process.env.WHATSAPP_STALE_MAX_AGE_SEC || "3600");
const WA_DB_PATH = process.env.WHATSAPP_DB_PATH || "/home/fjds/projects/whatsapp/db/whatsapp.db";
const USER_FOLDER = process.env.COBRAIN_USER_FOLDER || `${process.env.HOME}/.cobrain/users/${process.env.MY_TELEGRAM_ID}`;
const ALLOWED_GROUP_JIDS = (process.env.WHATSAPP_ALLOWED_GROUP_JIDS || "")
  .split(",").map(j => j.trim()).filter(Boolean);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const LOG_CHANNEL_ID = process.env.WA_LOG_CHANNEL_ID || "";
const HUB_CHAT_ID = parseInt(process.env.COBRAIN_HUB_ID || "0") || undefined;
const WA_TOPIC_ID = parseInt(process.env.WA_AGENT_TOPIC_ID || "0") || undefined;

// ── Telegram Log Channel ─────────────────────────────────────────────────

async function sendLog(text: string): Promise<void> {
  if (!BOT_TOKEN) return;

  // Prefer hub topic if available
  if (HUB_CHAT_ID && WA_TOPIC_ID) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: HUB_CHAT_ID,
          message_thread_id: WA_TOPIC_ID,
          text: text.slice(0, 4096),
          parse_mode: "HTML",
        }),
      });
      if (res.ok) return;
    } catch {}
  }

  // Fallback: flat log channel
  if (!LOG_CHANNEL_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: LOG_CHANNEL_ID, text: text.slice(0, 4096), parse_mode: "HTML" }),
    });
  } catch {}
}

// ── System Prompt (Mind Files) ────────────────────────────────────────────

const WA_MIND_DIR = `${USER_FOLDER}/agents/wa/mind`;
const SHARED_MIND_DIR = `${USER_FOLDER}/mind`;

const WA_MIND_FILES = ["identity.md", "rules.md", "tone.md"];
const SHARED_FILES = ["contacts.md"];

async function buildWaSystemPrompt(): Promise<string> {
  const sections: string[] = [];

  // WA-specific mind files
  for (const file of WA_MIND_FILES) {
    try {
      const content = await Bun.file(`${WA_MIND_DIR}/${file}`).text();
      if (content.trim()) sections.push(content.trim());
    } catch {}
  }

  // Shared files (contacts — aynı kişiler, hangi kanaldan olursa olsun)
  for (const file of SHARED_FILES) {
    try {
      const content = await Bun.file(`${SHARED_MIND_DIR}/${file}`).text();
      if (content.trim()) sections.push(content.trim());
    } catch {}
  }

  // WA context (session state)
  try {
    const content = await Bun.file(`${WA_MIND_DIR}/context.md`).text();
    if (content.trim()) sections.push(content.trim());
  } catch {}

  if (sections.length === 0) {
    return `Sen Cobrain'in WhatsApp agent'ısın. Türkçe, kısa, doğal cevaplar yaz.
Emin değilsen cevap verme — Cobrain'e bildir.`;
  }

  return sections.join("\n\n---\n\n");
}

// ── WhatsApp DB ───────────────────────────────────────────────────────────

let db: Database | null = null;

function getDB(): Database | null {
  if (db) return db;
  try {
    db = new Database(WA_DB_PATH);
    db.run("PRAGMA journal_mode = WAL");
    console.log("[WA Agent] DB bağlandı:", WA_DB_PATH);
    return db;
  } catch (err) {
    console.error("[WA Agent] DB bağlanamadı:", err);
    return null;
  }
}

function getPendingNotifications(limit = 10) {
  const d = getDB();
  if (!d) return [];
  try {
    return d.query<{
      id: number; chat_jid: string; sender_jid: string | null;
      sender_name: string | null; message_id: string | null;
      content: string | null; message_type: string | null;
      message_timestamp: number | null; is_group: number;
    }, []>(`
      SELECT n.id, n.chat_jid, n.sender_jid, n.sender_name, n.message_id,
             m.content, m.message_type, m.timestamp as message_timestamp,
             c.is_group
      FROM notifications n
      LEFT JOIN messages m ON n.message_id = m.id
      LEFT JOIN chats c ON n.chat_jid = c.jid
      WHERE n.status = 'pending'
      ORDER BY n.created_at ASC
      LIMIT ?
    `).all(limit);
  } catch { return []; }
}

function markNotificationsRead(ids: number[]) {
  const d = getDB();
  if (!d || ids.length === 0) return;
  try {
    d.run(`UPDATE notifications SET status='read' WHERE id IN (${ids.map(() => "?").join(",")})`, ids as unknown[]);
  } catch {}
}

function getRecentMessages(chatJid: string, limit = 10) {
  const d = getDB();
  if (!d) return [];
  try {
    return d.query<{
      content: string | null; is_from_me: number; timestamp: number | null;
      sender_name?: string | null;
    }, [string, number]>(`
      SELECT m.content, m.is_from_me, m.timestamp,
             n.sender_name
      FROM messages m
      LEFT JOIN notifications n ON m.id = n.message_id
      WHERE m.chat_jid = ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(chatJid, limit).reverse();
  } catch { return []; }
}

// ── Direct Outbox Write ──────────────────────────────────────────────────

function addToOutbox(to: string, message: string): number | null {
  const d = getDB();
  if (!d) return null;
  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const result = d.run(
      `INSERT INTO outbox (chat_jid, content, status, created_at) VALUES (?, ?, 'pending', datetime('now'))`,
      [jid, message],
    );
    console.log(`[WA Agent] Outbox'a yazıldı: ${jid} (#${result.lastInsertRowid})`);
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.error("[WA Agent] Outbox yazma hatası:", err);
    return null;
  }
}

// ── In-Memory Dedup ───────────────────────────────────────────────────────

const recentReplies = new Map<string, number>(); // chatJid → timestamp
const DM_DEDUP_TTL_MS = 60_000;
const GROUP_DEDUP_TTL_MS = 5 * 60_000; // Grup başına 5dk cooldown

function wasRecentlyReplied(chatJid: string, isGroup: boolean): boolean {
  const ts = recentReplies.get(chatJid);
  if (!ts) return false;
  const ttl = isGroup ? GROUP_DEDUP_TTL_MS : DM_DEDUP_TTL_MS;
  if (Date.now() - ts > ttl) { recentReplies.delete(chatJid); return false; }
  return true;
}

function markReplied(chatJid: string) {
  recentReplies.set(chatJid, Date.now());
}

// Inbox'ta bekleyen chatJid'ler (processAfter dahil double-push engeli)
const pendingChats = new Set<string>();
// Debounce timer'ları — her yeni mesajda timer sıfırlanır
const dmTimers = new Map<string, Timer>();

// ── Message Processing via Agent SDK ─────────────────────────────────────
// Doğrudan Agent SDK — HTTP katmanı yok

async function processDM(
  chatJid: string,
  senderName: string,
  messages: Array<{ content: string | null; is_from_me: number }>,
): Promise<void> {
  const systemPrompt = await buildWaSystemPrompt();
  const history = messages.map(m =>
    `[${m.is_from_me ? "Ben" : senderName}]: ${m.content || "[medya]"}`
  ).join("\n");

  const toNumber = chatJid.replace("@s.whatsapp.net", "").replace("@lid", "");
  const prompt = `WhatsApp DM — ${senderName}

Son mesajlar:
${history}

Kurallarına göre bu kişiye cevap ver. Cevap vereceksen mcp__whatsapp__send_whatsapp_message tool'unu MUTLAKA kullan.
to: "${toNumber}"
Hafızayı kontrol etmen gerekiyorsa mcp__memory__recall tool'unu kullan.
Cevap vermeyeceksen nedenini kısaca açıkla.`;

  const sessionKey = `wa_${chatJid.replace(/[^a-zA-Z0-9]/g, "_")}`;

  try {
    await sendLog(`🔄 <b>DM başladı:</b> ${senderName}\n💬 ${messages[messages.length - 1]?.content?.slice(0, 100) || "[medya]"}`);

    const result = await waChat(prompt, sessionKey, systemPrompt, {
      onToolUse: (toolName) => {
        sendLog(`🔧 <b>Tool:</b> ${toolName}`);
      },
    });

    if (!result.content) {
      await sendLog(`⚠️ <b>DM:</b> ${senderName} — yanıt alınamadı`);
      return;
    }

    markReplied(chatJid);
    const toolList = result.toolsUsed.length > 0 ? `\n🔧 Tools: ${result.toolsUsed.join(", ")}` : "";
    await sendLog(`📨 <b>DM:</b> ${senderName}\n↩️ ${result.content.slice(0, 200)}${toolList}\n⚙️ ${result.numTurns} turn`);
  } catch (err) {
    console.error(`[WA Agent] AI hatası (${chatJid}):`, err);
    await sendLog(`❌ <b>DM Hata:</b> ${senderName}\n${String(err).slice(0, 200)}`);
  }
}

async function processGroup(
  groupJid: string,
  groupName: string,
  messages: Array<{ sender_name: string; content: string | null }>,
): Promise<void> {
  const systemPrompt = await buildWaSystemPrompt();
  const msgTexts = messages.map(m => `${m.sender_name}: ${m.content || "[medya]"}`).join("\n");

  const prompt = `WhatsApp Grup — ${groupName}

Son mesajlar:
${msgTexts}

Kurallarına göre bu grup mesajlarını değerlendir. Cevap vereceksen mcp__whatsapp__send_whatsapp_message tool'unu MUTLAKA kullan.
to: "${groupJid}"
Bilgi kaydetmen gerekiyorsa mcp__memory__remember tool'unu kullan.
Cevap vermeyeceksen sessizce geç.`;

  const sessionKey = `wa_group_${groupJid.replace(/[^a-zA-Z0-9]/g, "_")}`;

  try {
    await sendLog(`🔄 <b>Grup başladı:</b> ${groupName} (${messages.length} mesaj)\n💬 ${msgTexts.slice(0, 150)}`);

    const result = await waChat(prompt, sessionKey, systemPrompt, {
      onToolUse: (toolName) => {
        sendLog(`🔧 <b>Tool:</b> ${toolName}`);
      },
    });

    if (!result.content) {
      await sendLog(`⚠️ <b>Grup:</b> ${groupName} — yanıt alınamadı`);
      return;
    }

    markReplied(groupJid);
    const toolList = result.toolsUsed.length > 0 ? `\n🔧 Tools: ${result.toolsUsed.join(", ")}` : "";
    await sendLog(`👥 <b>Grup:</b> ${groupName}\n↩️ ${result.content.slice(0, 200)}${toolList}\n⚙️ ${result.numTurns} turn`);
  } catch (err) {
    console.error(`[WA Agent] Grup AI hatası (${groupJid}):`, err);
    await sendLog(`❌ <b>Grup Hata:</b> ${groupName}\n${String(err).slice(0, 200)}`);
  }
}

// ── Poll Loop ─────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const notifications = getPendingNotifications(20);
  if (notifications.length === 0) return;

  const nowSec = Math.floor(Date.now() / 1000);

  // Status broadcasts → mark read immediately
  const statusIds = notifications.filter(n => n.chat_jid === "status@broadcast").map(n => n.id);
  if (statusIds.length > 0) markNotificationsRead(statusIds);

  // Stale messages → mark read
  const staleIds = notifications
    .filter(n => {
      if (n.chat_jid === "status@broadcast") return false; // already handled
      const ts = n.message_timestamp || 0;
      return ts > 0 && (nowSec - ts) >= MAX_AGE_SEC;
    })
    .map(n => n.id);
  if (staleIds.length > 0) {
    markNotificationsRead(staleIds);
    console.log(`[WA Agent] ${staleIds.length} stale notification atlandı`);
  }

  // Fresh messages (excluding status + stale)
  const handledIds = new Set([...statusIds, ...staleIds]);
  const fresh = notifications.filter(n => !handledIds.has(n.id));

  // Split into DMs and groups
  const dms = fresh.filter(n => !n.is_group);
  const groups = fresh.filter(n => n.is_group);

  // ── Process DMs ──
  const dmBySender = new Map<string, typeof dms>();
  for (const n of dms) {
    if (!dmBySender.has(n.chat_jid)) dmBySender.set(n.chat_jid, []);
    dmBySender.get(n.chat_jid)!.push(n);
  }

  for (const [chatJid, msgs] of dmBySender) {
    const senderName = msgs[0]?.sender_name || chatJid.split("@")[0] || "?";

    // Guard 1: dedup
    if (wasRecentlyReplied(chatJid, false)) {
      markNotificationsRead(msgs.map(m => m.id));
      continue;
    }

    markNotificationsRead(msgs.map(m => m.id));

    // Debounce: her yeni mesajda timer sıfırla (üst üste mesajlar gruplansın)
    const existing = dmTimers.get(chatJid);
    if (existing) clearTimeout(existing);

    pendingChats.add(chatJid);
    const timer = setTimeout(async () => {
      dmTimers.delete(chatJid);
      pendingChats.delete(chatJid);
      // History'yi İŞLEM ANINDA al — bekleme sırasında gelen mesajlar da dahil
      const history = getRecentMessages(chatJid, 10);
      console.log(`[WA Agent] DM işleniyor: ${senderName}`);
      await processDM(chatJid, senderName, history);
    }, 5_000);
    dmTimers.set(chatJid, timer);

    console.log(`[WA Agent] DM kuyruğa alındı/yenilendi (5s): ${senderName}`);
  }

  // ── Process Groups ──
  const groupByJid = new Map<string, typeof groups>();
  for (const n of groups) {
    if (!groupByJid.has(n.chat_jid)) groupByJid.set(n.chat_jid, []);
    groupByJid.get(n.chat_jid)!.push(n);
  }

  for (const [groupJid, msgs] of groupByJid) {
    const groupName = msgs[0]?.sender_name?.split(" @ ")[1] || groupJid;
    const isAllowed = ALLOWED_GROUP_JIDS.length > 0 && ALLOWED_GROUP_JIDS.includes(groupJid);

    // İzin verilmeyen gruplarda: sadece markRead
    if (!isAllowed) {
      markNotificationsRead(msgs.map(m => m.id));
      continue;
    }

    // Guard: grup dedup (5dk cooldown)
    if (wasRecentlyReplied(groupJid, true)) {
      markNotificationsRead(msgs.map(m => m.id));
      continue;
    }

    // Guard: zaten pending
    if (pendingChats.has(groupJid)) {
      markNotificationsRead(msgs.map(m => m.id));
      continue;
    }

    const groupMessages = msgs.map(m => ({
      sender_name: m.sender_name?.split(" @ ")[0] || "?",
      content: m.content,
    }));

    pendingChats.add(groupJid);
    markNotificationsRead(msgs.map(m => m.id));

    // Gruplar hemen işlenir (DM'lerdeki 30s bekleme yok)
    console.log(`[WA Agent] Grup işleniyor: ${groupName} (${msgs.length} mesaj)`);
    processGroup(groupJid, groupName, groupMessages).catch(err => {
      console.error(`[WA Agent] Grup hata (${groupJid}):`, err);
    }).finally(() => {
      pendingChats.delete(groupJid);
    });
  }
}

// ── Mini HTTP Server (Cobrain'den görev alır) ─────────────────────────────

Bun.serve({
  port: AGENT_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", agent: "wa", uptime: Math.round(process.uptime()) });
    }

    // POST /send — Doğrudan mesaj gönder (tool hook'ları buraya yönlendirir)
    if (url.pathname === "/send" && req.method === "POST") {
      const auth = req.headers.get("authorization");
      if (!API_KEY || auth !== `Bearer ${API_KEY}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const body = await req.json() as { to: string; message: string };
        if (!body.to || !body.message) {
          return Response.json({ error: "to and message required" }, { status: 400 });
        }
        const id = addToOutbox(body.to, body.message);
        if (id === null) {
          return Response.json({ error: "DB write failed" }, { status: 500 });
        }
        return Response.json({ ok: true, outboxId: id });
      } catch {
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
    }

    // POST /task — Cobrain'den görev al
    if (url.pathname === "/task" && req.method === "POST") {
      const auth = req.headers.get("authorization");
      if (!API_KEY || auth !== `Bearer ${API_KEY}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        const body = await req.json() as { goal?: string; chatJid?: string; message?: string };
        console.log(`[WA Agent] Görev alındı:`, body);
        // TODO: görevi işle
        return Response.json({ ok: true, queued: true });
      } catch {
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[WA Agent] Başlatıldı (port: ${AGENT_PORT}, poll: ${POLL_INTERVAL_MS}ms, gruplar: ${ALLOWED_GROUP_JIDS.length > 0 ? ALLOWED_GROUP_JIDS.join(",") : "yok"})`);
sendLog(`🟢 <b>WA Agent başlatıldı</b>\nPort: ${AGENT_PORT} | Poll: ${POLL_INTERVAL_MS / 1000}s | Gruplar: ${ALLOWED_GROUP_JIDS.length > 0 ? ALLOWED_GROUP_JIDS.length : "yok"}`);

// ── Start ─────────────────────────────────────────────────────────────────

poll().catch(err => console.error("[WA Agent] İlk poll hatası:", err));
setInterval(() => poll().catch(err => console.error("[WA Agent] Poll hatası:", err)), POLL_INTERVAL_MS);

process.on("SIGINT", () => { console.log("[WA Agent] Kapatılıyor..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("[WA Agent] Kapatılıyor..."); process.exit(0); });

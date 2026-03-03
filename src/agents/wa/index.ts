/**
 * WA Agent — Bağımsız WhatsApp İletişim Process'i
 *
 * Cobrain'den bağımsız process olarak çalışır:
 * - Kendi WhatsApp DB poll loop'u (30s)
 * - AI inference: Cobrain /api/chat üzerinden (OAuth — ANTHROPIC_API_KEY gereksiz)
 * - Cobrain'e HTTP üzerinden rapor/görev
 * - Kendi mini HTTP server (Cobrain'den görev alır)
 * - Her chat için izole session (sessionKey: wa_<chatJid>)
 *
 * Başlatma: bun run src/agents/wa/index.ts
 * Cobrain startup.ts üzerinden Bun.spawn() ile de başlatılır.
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";

// ── Config ───────────────────────────────────────────────────────────────

const COBRAIN_URL = process.env.WEB_URL || "http://localhost:3000";
const API_KEY = process.env.COBRAIN_API_KEY || "";
const AGENT_PORT = parseInt(process.env.WA_AGENT_PORT || "3001");
const POLL_INTERVAL_MS = 30_000;
const MAX_AGE_SEC = parseInt(process.env.WHATSAPP_STALE_MAX_AGE_SEC || "3600");
const WA_DB_PATH = process.env.WHATSAPP_DB_PATH || "/home/fjds/projects/whatsapp/db/whatsapp.db";
const USER_FOLDER = process.env.COBRAIN_USER_FOLDER || `${process.env.HOME}/.cobrain/users/${process.env.MY_TELEGRAM_ID}`;

// ── System Prompt ─────────────────────────────────────────────────────────

function loadSystemPrompt(): string {
  const path = `${USER_FOLDER}/agents/wa/system-prompt.md`;
  if (existsSync(path)) return readFileSync(path, "utf-8");
  return `Sen Cobrain'in WhatsApp agent'ısın. T1-T2 kişilere uygun, kısa, doğal Türkçe cevaplar yaz.
Emin değilsen cevap verme — Cobrain'e bildir.`;
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
    }, [string, number]>(`
      SELECT content, is_from_me, timestamp
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(chatJid, limit).reverse();
  } catch { return []; }
}

function getRecentOutgoing(chatJid: string, sinceTs: number) {
  const d = getDB();
  if (!d) return [];
  try {
    return d.query<{ content: string | null; timestamp: number }, [string, number]>(`
      SELECT content, timestamp FROM messages
      WHERE chat_jid = ? AND is_from_me = 1 AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 5
    `).all(chatJid, sinceTs);
  } catch { return []; }
}

// ── In-Memory Dedup ───────────────────────────────────────────────────────

const recentReplies = new Map<string, number>(); // chatJid → timestamp
const DEDUP_TTL_MS = 60_000;

function wasRecentlyReplied(chatJid: string): boolean {
  const ts = recentReplies.get(chatJid);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) { recentReplies.delete(chatJid); return false; }
  return true;
}

function markReplied(chatJid: string) {
  recentReplies.set(chatJid, Date.now());
}

// Inbox'ta bekleyen chatJid'ler (processAfter dahil double-push engeli)
const pendingChats = new Set<string>();

// ── Cobrain HTTP Proxy ────────────────────────────────────────────────────

async function cobrainPost(path: string, body: object): Promise<boolean> {
  try {
    const res = await fetch(`${COBRAIN_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch { return false; }
}

async function sendWhatsApp(to: string, message: string): Promise<boolean> {
  return cobrainPost("/api/whatsapp/send", { to, message });
}

async function reportToCobrain(subject: string, message: string, priority: "urgent" | "normal" = "normal") {
  await cobrainPost("/api/report", { agentId: "wa", subject, message, priority });
}

async function recallMemory(query = "contacts rules"): Promise<string> {
  try {
    const res = await fetch(`${COBRAIN_URL}/api/memory/recall?query=${encodeURIComponent(query)}&days=30`, {
      headers: { "Authorization": `Bearer ${API_KEY}` },
    });
    if (!res.ok) return "";
    const data = await res.json() as { facts?: string; events?: string };
    const parts = [data.facts || "", data.events || ""].filter(Boolean);
    return parts.join("\n\n---\n\n").slice(0, 3000);
  } catch { return ""; }
}

async function rememberMemory(content: string, type: "semantic" | "episodic" = "episodic", section?: string): Promise<boolean> {
  try {
    const res = await fetch(`${COBRAIN_URL}/api/memory/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify({ content, type, section }),
    });
    return res.ok;
  } catch { return false; }
}

// ── Message Processing via Cobrain /api/chat ─────────────────────────────
// ANTHROPIC_API_KEY gereksiz — Cobrain OAuth üzerinden AI çağrısı yapar.
// Her chat için izole session: sessionKey = "wa_<chatJid>"

async function askCobrain(prompt: string, sessionKey: string, systemPrompt: string): Promise<string> {
  try {
    const res = await fetch(`${COBRAIN_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
      body: JSON.stringify({
        message: prompt,
        sessionKey,
        silent: true,
        systemPromptOverride: systemPrompt,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[WA Agent] /api/chat hata ${res.status}: ${err.slice(0, 200)}`);
      return "";
    }
    const data = await res.json() as { content?: string; response?: string };
    return data.content || data.response || "";
  } catch (err) {
    console.error("[WA Agent] /api/chat erişim hatası:", err);
    return "";
  }
}

async function processMessage(
  chatJid: string,
  senderName: string,
  messages: Array<{ content: string; is_from_me: number }>,
  memory: string,
): Promise<void> {
  const systemPrompt = loadSystemPrompt();
  const history = messages.map(m =>
    `[${m.is_from_me ? "Ben" : senderName}]: ${m.content || "[medya]"}`
  ).join("\n");

  const prompt = `[WA-AGENT] WhatsApp DM — ${senderName} (jid: ${chatJid})

Son mesajlar:
${history}

Hafıza özeti:
${memory || "(yok)"}

Görevin: Bu mesaja ne yapmalısın?
- Cevap vereceksen: send_whatsapp_message tool'unu kullan (to: ${chatJid.replace("@s.whatsapp.net", "").replace("@lid", "")})
- Geçeceksen: açıkla neden
- Cobrain'e bildirmek istersen: notify_cobrain tool'unu kullan`;

  const sessionKey = `wa_${chatJid.replace(/[^a-zA-Z0-9]/g, "_")}`;

  try {
    console.log(`[WA Agent] Cobrain'e soruluyor: ${senderName} (session: ${sessionKey})`);
    const response = await askCobrain(prompt, sessionKey, systemPrompt);

    if (!response) {
      console.error(`[WA Agent] Cobrain'den yanıt alınamadı: ${chatJid}`);
      return;
    }

    console.log(`[WA Agent] Cobrain yanıtı (${response.length} karakter): ${response.slice(0, 100)}...`);
    // Cobrain tool'ları kendi çağırıyor (send_whatsapp_message, notify_cobrain)
    // Mesaj gönderildiyse dedup için markReplied
    markReplied(chatJid);
  } catch (err) {
    console.error(`[WA Agent] AI hatası (${chatJid}):`, err);
    await reportToCobrain(
      `WA agent hata — ${senderName}`,
      `chatJid: ${chatJid}\nHata: ${String(err).slice(0, 200)}`,
      "urgent",
    );
  }
}

// ── Poll Loop ─────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  const notifications = getPendingNotifications(10);
  if (notifications.length === 0) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const dms = notifications.filter(n => !n.is_group && n.chat_jid !== "status@broadcast");
  const staleIds = notifications
    .filter(n => {
      if (n.chat_jid === "status@broadcast") return true;
      const ts = n.message_timestamp || 0;
      return ts > 0 && (nowSec - ts) >= MAX_AGE_SEC;
    })
    .map(n => n.id);

  if (staleIds.length > 0) {
    markNotificationsRead(staleIds);
  }

  const freshDMs = dms.filter(n => {
    const ts = n.message_timestamp || 0;
    return ts === 0 || (nowSec - ts) < MAX_AGE_SEC;
  });

  const bySender = new Map<string, typeof freshDMs>();
  for (const n of freshDMs) {
    if (!bySender.has(n.chat_jid)) bySender.set(n.chat_jid, []);
    bySender.get(n.chat_jid)!.push(n);
  }

  // Lazy memory load — sadece işlenecek mesaj varsa
  let memory = "";
  let memoryLoaded = false;

  for (const [chatJid, msgs] of bySender) {
    const senderName = msgs[0]?.sender_name || chatJid.split("@")[0] || "?";

    // Guard 1: dedup
    if (wasRecentlyReplied(chatJid)) {
      markNotificationsRead(msgs.map(m => m.id));
      continue;
    }

    // Guard 2: zaten pending
    if (pendingChats.has(chatJid)) {
      markNotificationsRead(msgs.map(m => m.id));
      continue;
    }

    // Guard 3: Fekrat son 120s cevap yazdıysa
    const recentOutgoing = getRecentOutgoing(chatJid, nowSec - 120);
    if (recentOutgoing.length > 0) {
      markNotificationsRead(msgs.map(m => m.id));
      console.log(`[WA Agent] Geçildi (user replied): ${senderName}`);
      continue;
    }

    // Lazy load memory
    if (!memoryLoaded) {
      memory = await recallMemory();
      memoryLoaded = true;
    }

    // Tüm recent mesajları çek (history için)
    const history = getRecentMessages(chatJid, 10);

    pendingChats.add(chatJid);
    markNotificationsRead(msgs.map(m => m.id));

    // 30s beklet sonra işle
    setTimeout(async () => {
      pendingChats.delete(chatJid);

      // Guard 3 tekrar: beklerken Fekrat cevap yazdı mı?
      const nowSec2 = Math.floor(Date.now() / 1000);
      const outgoing2 = getRecentOutgoing(chatJid, nowSec2 - 120);
      if (outgoing2.length > 0) {
        console.log(`[WA Agent] Geçildi (user replied during wait): ${senderName}`);
        return;
      }

      console.log(`[WA Agent] İşleniyor: ${senderName}`);
      await processMessage(chatJid, senderName, history, memory);
    }, 30_000);

    console.log(`[WA Agent] Kuyruğa alındı (30s): ${senderName}`);
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

console.log(`[WA Agent] Başlatıldı (port: ${AGENT_PORT}, poll: ${POLL_INTERVAL_MS}ms)`);

// ── Start ─────────────────────────────────────────────────────────────────

poll().catch(err => console.error("[WA Agent] İlk poll hatası:", err));
setInterval(() => poll().catch(err => console.error("[WA Agent] Poll hatası:", err)), POLL_INTERVAL_MS);

process.on("SIGINT", () => { console.log("[WA Agent] Kapatılıyor..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("[WA Agent] Kapatılıyor..."); process.exit(0); });

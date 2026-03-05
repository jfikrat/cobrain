/**
 * WhatsApp Tools — Hub-based WA Agent MCP Server
 *
 * wa_check_messages: Pending notification'ları kontrol et, history ile formatla
 * wa_send_message: Outbox'a mesaj yaz
 * hasPendingWAMessages(): BrainLoop'un lightweight DB check'i (AI çağırmadan)
 */

import { Database } from "bun:sqlite";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { toolSuccess, toolError } from "../../utils/tool-response.ts";
import { config } from "../../config.ts";

// ── DB Connection ───────────────────────────────────────────────────────────

let db: Database | null = null;

function getDB(): Database | null {
  if (db) return db;
  try {
    db = new Database(config.WHATSAPP_DB_PATH);
    db.run("PRAGMA journal_mode = WAL");
    return db;
  } catch (err) {
    console.error("[WA Tools] DB bağlanamadı:", err);
    return null;
  }
}

// ── Lightweight Pending Check (no AI call) ──────────────────────────────────

/**
 * BrainLoop'un kullanacağı hafif kontrol.
 * AI çağırmadan sadece pending notification sayısını kontrol eder.
 */
export function hasPendingWAMessages(): boolean {
  const d = getDB();
  if (!d) return false;
  try {
    const row = d.query<{ cnt: number }, []>(
      `SELECT COUNT(*) as cnt FROM notifications WHERE status = 'pending'`
    ).get();
    return (row?.cnt ?? 0) > 0;
  } catch {
    return false;
  }
}

// ── wa_check_messages Tool ──────────────────────────────────────────────────

const MAX_AGE_SEC = 3600; // 1 saat

const waCheckMessagesTool = tool(
  "wa_check_messages",
  "WhatsApp'taki yeni mesajları kontrol et. Pending notification'ları çeker, status broadcast ve stale olanları filtreler, her chat için son mesaj history'sini gösterir.",
  {},
  async () => {
    const d = getDB();
    if (!d) return toolError("WA DB", new Error("Veritabanına bağlanılamadı"));

    try {
      // Pending notification'ları çek
      const notifications = d.query<{
        id: number;
        chat_jid: string;
        sender_jid: string | null;
        sender_name: string | null;
        message_id: string | null;
        content: string | null;
        message_type: string | null;
        message_timestamp: number | null;
        is_group: number;
      }, []>(`
        SELECT n.id, n.chat_jid, n.sender_jid, n.sender_name, n.message_id,
               m.content, m.message_type, m.timestamp as message_timestamp,
               c.is_group
        FROM notifications n
        LEFT JOIN messages m ON n.message_id = m.id
        LEFT JOIN chats c ON n.chat_jid = c.jid
        WHERE n.status = 'pending'
        ORDER BY n.created_at ASC
        LIMIT 20
      `).all();

      if (notifications.length === 0) {
        return toolSuccess("Yeni WhatsApp mesajı yok.");
      }

      const nowSec = Math.floor(Date.now() / 1000);

      // Status broadcast → mark read
      const statusIds = notifications.filter(n => n.chat_jid === "status@broadcast").map(n => n.id);
      if (statusIds.length > 0) {
        d.run(`UPDATE notifications SET status='read' WHERE id IN (${statusIds.map(() => "?").join(",")})`, statusIds as any[]);
      }

      // Stale (>1 saat) → mark read
      const staleIds = notifications
        .filter(n => {
          if (n.chat_jid === "status@broadcast") return false;
          const ts = n.message_timestamp || 0;
          return ts > 0 && (nowSec - ts) >= MAX_AGE_SEC;
        })
        .map(n => n.id);
      if (staleIds.length > 0) {
        d.run(`UPDATE notifications SET status='read' WHERE id IN (${staleIds.map(() => "?").join(",")})`, staleIds as any[]);
      }

      // Fresh messages
      const handledIds = new Set([...statusIds, ...staleIds]);
      const fresh = notifications.filter(n => !handledIds.has(n.id));

      if (fresh.length === 0) {
        return toolSuccess("Yeni mesaj yok (status/stale filtrelendi).");
      }

      // Mark all fresh as read
      const freshIds = fresh.map(n => n.id);
      d.run(`UPDATE notifications SET status='read' WHERE id IN (${freshIds.map(() => "?").join(",")})`, freshIds as any[]);

      // Group by chat
      const chatMap = new Map<string, typeof fresh>();
      for (const n of fresh) {
        if (!chatMap.has(n.chat_jid)) chatMap.set(n.chat_jid, []);
        chatMap.get(n.chat_jid)!.push(n);
      }

      // Build formatted output with history
      const sections: string[] = [];

      for (const [chatJid, msgs] of chatMap) {
        const isGroup = msgs[0]?.is_group === 1;
        const senderName = msgs[0]?.sender_name?.split(" @ ")[0] || chatJid.split("@")[0] || "?";
        const groupName = isGroup ? (msgs[0]?.sender_name?.split(" @ ")[1] || chatJid) : null;

        // Get recent history for this chat
        const history = d.query<{
          content: string | null;
          is_from_me: number;
          timestamp: number | null;
          sender_name: string | null;
        }, [string, number]>(`
          SELECT m.content, m.is_from_me, m.timestamp,
                 n.sender_name
          FROM messages m
          LEFT JOIN notifications n ON m.id = n.message_id
          WHERE m.chat_jid = ?
          ORDER BY m.timestamp DESC
          LIMIT ?
        `).all(chatJid, 10).reverse();

        const header = isGroup
          ? `## Grup: ${groupName} (${chatJid})`
          : `## DM: ${senderName} (${chatJid})`;

        const historyLines = history.map(h => {
          if (h.is_from_me) {
            return `[Ben]: ${h.content || "[medya]"}`;
          }
          const name = isGroup
            ? (h.sender_name?.split(" @ ")[0] || "?")
            : senderName;
          return `[${name}]: ${h.content || "[medya]"}`;
        });

        sections.push(`${header}\n${historyLines.join("\n")}`);
      }

      const summary = `${fresh.length} yeni mesaj, ${chatMap.size} sohbet:\n\n${sections.join("\n\n")}`;
      return toolSuccess(summary);
    } catch (err) {
      return toolError("WA check hatası", err);
    }
  },
);

// ── wa_send_message Tool ────────────────────────────────────────────────────

const waSendMessageTool = tool(
  "wa_send_message",
  "WhatsApp mesajı gönder. Kişinin telefon numarasını (905551234567) veya JID'ini (905551234567@s.whatsapp.net) ver.",
  {
    to: z.string().describe("Telefon numarası (905551234567) veya JID (905551234567@s.whatsapp.net veya grup JID)"),
    message: z.string().describe("Gönderilecek mesaj metni"),
  },
  async ({ to, message }) => {
    const d = getDB();
    if (!d) return toolError("WA DB", new Error("Veritabanına bağlanılamadı"));

    try {
      const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
      const result = d.run(
        `INSERT INTO outbox (chat_jid, content, status, created_at) VALUES (?, ?, 'pending', datetime('now'))`,
        [jid, message],
      );
      console.log(`[WA Tools] Outbox'a yazıldı: ${jid} (#${result.lastInsertRowid})`);
      return toolSuccess(`Mesaj kuyruğa alındı: ${jid} (#${result.lastInsertRowid})`);
    } catch (err) {
      return toolError("WA mesaj gönderme hatası", err);
    }
  },
);

// ── MCP Server Factory ──────────────────────────────────────────────────────

export function createWhatsAppServer() {
  return createSdkMcpServer({
    name: "whatsapp",
    version: "1.0.0",
    tools: [waCheckMessagesTool, waSendMessageTool],
  });
}

/**
 * WhatsApp MCP Server — Pure WebSocket Client
 *
 * Worker daemon'un WS API'sine bağlanır. Sıfır SQLite dependency.
 * Read ve write işlemlerin tamamı WS üzerinden yapılır.
 */

import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { toolSuccess, toolError } from "../../utils/tool-response.ts";
import { config } from "../../config.ts";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

// ── WS Port Resolution ──────────────────────────────────────────────────

const WS_PORT_FILE = "/home/fjds/projects/whatsapp/.ws-port";

function getWsPort(): number {
  if (config.WHATSAPP_WS_PORT) return config.WHATSAPP_WS_PORT;
  try {
    const port = Number(readFileSync(WS_PORT_FILE, "utf8").trim());
    if (port >= 10000 && port <= 65535) return port;
  } catch {}
  throw new Error("WHATSAPP_WS_PORT not set and .ws-port file not found");
}

// ── WS Client ────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function connectWs(): Promise<WebSocket> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  return new Promise((resolve, reject) => {
    const port = getWsPort();
    const socket = new WebSocket(`ws://localhost:${port}`);
    socket.onopen = () => { ws = socket; resolve(socket); };
    socket.onerror = () => reject(new Error("Worker WS bağlantısı kurulamadı"));
    socket.onclose = () => { ws = null; };
    socket.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        if (data.id && pending.has(data.id)) {
          const p = pending.get(data.id)!;
          pending.delete(data.id);
          if (data.ok) p.resolve(data.result);
          else p.reject(new Error(data.error || "WS hatası"));
        }
      } catch {}
    };
  });
}

async function wsCall(action: string, params?: Record<string, any>): Promise<any> {
  const socket = await connectWs();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`WS timeout (30s): ${action}`));
    }, 30_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); },
    });
    socket.send(JSON.stringify({ id, action, params }));
  });
}

// ── File Helpers (for send_image/send_document) ──────────────────────────

const ALLOWED_DIRS = ["/home", "/tmp"];
const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mp3: "audio/mpeg", ogg: "audio/ogg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip", txt: "text/plain",
};

function detectMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return MIME_MAP[ext] || "application/octet-stream";
}

function validateAndReadFile(filePath: string): { error?: string; base64?: string; filename?: string } {
  if (!filePath) return { error: "Dosya yolu boş olamaz." };
  if (filePath.includes("..")) return { error: "Path traversal tespit edildi." };

  const resolved = isAbsolute(filePath) ? resolve(filePath) : resolve(filePath);
  let canonical: string;
  try { canonical = realpathSync(resolved); } catch { return { error: `Dosya bulunamadı: ${resolved}` }; }
  if (!existsSync(canonical)) return { error: `Dosya bulunamadı: ${resolved}` };

  const allowed = ALLOWED_DIRS.some(d => canonical === d || canonical.startsWith(`${d}/`));
  if (!allowed) return { error: `İzin verilen dizinlerde değil: ${ALLOWED_DIRS.join(", ")}` };

  const data = readFileSync(canonical);
  return {
    base64: Buffer.from(data).toString("base64"),
    filename: canonical.split("/").pop() || "file",
  };
}

// ── Formatting Helpers ───────────────────────────────────────────────────

const TZ = "Europe/Istanbul";

function fmtTime(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString("tr-TR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Tool Definitions ─────────────────────────────────────────────────────

const sendMessage = tool(
  "whatsapp_send_message",
  "WhatsApp mesajı veya dosya gönderir. file_path verilirse document olarak gönderir.",
  {
    to: z.string().describe("Alıcı (telefon numarası, isim veya JID)"),
    message: z.string().describe("Mesaj metni (dosya gönderiminde caption)"),
    file_path: z.string().optional().describe("Dosya yolu (sunucudaki absolute path)"),
    filename: z.string().optional().describe("Görüntülenecek dosya adı"),
  },
  async ({ to, message, file_path, filename }) => {
    try {
      if (file_path) {
        const file = validateAndReadFile(file_path);
        if (file.error) return toolSuccess(`Hata: ${file.error}`);
        const fname = filename || file.filename!;
        const result = await wsCall("send", {
          to, text: message,
          file: { data: file.base64, filename: fname, mimetype: detectMimetype(fname) },
        });
        return toolSuccess(`Dosya gönderildi.\nAlıcı: ${result?.contactName || to} (${result?.to || "?"})\nDosya: ${fname}\nID: ${result?.messageId || "?"}`);
      }
      const result = await wsCall("send", { to, text: message });
      return toolSuccess(`Mesaj gönderildi.\nAlıcı: ${result?.contactName || to} (${result?.to || "?"})\nID: ${result?.messageId || "?"}`);
    } catch (err) { return toolError("WA send", err); }
  },
);

const getChats = tool(
  "whatsapp_get_chats",
  "Son sohbetleri listeler",
  { limit: z.number().optional().default(20).describe("Maksimum sohbet sayısı") },
  async ({ limit }) => {
    try {
      const chats = await wsCall("get_chats", { limit });
      if (!chats?.length) return toolSuccess("Sohbet bulunamadı.");
      const list = chats.map((c: any, i: number) => {
        const name = c.name || c.jid?.split("@")[0] || "?";
        const time = fmtTime(c.last_message_timestamp);
        const unread = c.unread_count > 0 ? ` (${c.unread_count} okunmamış)` : "";
        return `${i + 1}. ${name}${unread} — ${time}`;
      });
      return toolSuccess(`Son ${chats.length} sohbet:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_chats", err); }
  },
);

const getMessages = tool(
  "whatsapp_get_messages",
  "Bir sohbetin mesaj geçmişini getirir",
  {
    chatId: z.string().describe("Sohbet ID, telefon numarası veya isim"),
    limit: z.number().optional().default(20).describe("Maksimum mesaj sayısı"),
  },
  async ({ chatId, limit }) => {
    try {
      const result = await wsCall("get_messages", { chatId, limit });
      const msgs = result?.messages;
      if (!msgs?.length) return toolSuccess(`${result?.contactName || chatId} ile mesaj geçmişi bulunamadı.`);
      const list = msgs.map((m: any) => {
        const time = fmtTime(m.timestamp);
        const sender = m.sender_name || (m.is_from_me ? "Ben" : "?");
        const media = m.media_path ? ` [Media]` : "";
        return `[${time}] ${sender}: ${m.content || "[medya]"}${media}`;
      });
      return toolSuccess(`${result.contactName} ile son ${msgs.length} mesaj:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_messages", err); }
  },
);

const getContacts = tool(
  "whatsapp_get_contacts",
  "Kişi listesini getirir",
  {
    query: z.string().optional().describe("Arama terimi"),
    limit: z.number().optional().default(50).describe("Maksimum sonuç"),
  },
  async ({ query, limit }) => {
    try {
      const contacts = await wsCall("get_contacts", { query, limit });
      if (!contacts?.length) return toolSuccess(query ? `"${query}" için kişi bulunamadı.` : "Kişi bulunamadı.");
      const list = contacts.map((c: any, i: number) => {
        const name = c.name || c.notify || c.verified_name || "[İsimsiz]";
        return `${i + 1}. ${name} — ${c.jid?.split("@")[0] || "?"}`;
      });
      return toolSuccess(`${query ? `"${query}" için ` : ""}${contacts.length} kişi:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_contacts", err); }
  },
);

const getStatus = tool(
  "whatsapp_get_status",
  "WhatsApp bağlantı durumunu ve istatistikleri gösterir",
  {},
  async () => {
    try {
      const s = await wsCall("get_status");
      return toolSuccess(
        `WhatsApp Durumu:\n\nWorker: ${s.connected ? "Bağlı" : "Bağlı değil"}\nKullanıcı: ${s.user || "?"}\nID: ${s.userId || "?"}\n\nVeritabanı:\n- Kişiler: ${s.contacts}\n- Sohbetler: ${s.chats}\n- Mesajlar: ${s.messages}`
      );
    } catch (err) { return toolError("WA get_status", err); }
  },
);

const getGroups = tool(
  "whatsapp_get_groups",
  "WhatsApp gruplarını listeler",
  { limit: z.number().optional().default(20).describe("Maksimum grup sayısı") },
  async ({ limit }) => {
    try {
      const groups = await wsCall("get_groups", { limit });
      if (!groups?.length) return toolSuccess("Grup bulunamadı.");
      const list = groups.map((g: any, i: number) => {
        const time = fmtTime(g.last_message_timestamp);
        return `${i + 1}. ${g.name || g.jid} — ${time}`;
      });
      return toolSuccess(`${groups.length} grup:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_groups", err); }
  },
);

const sendImage = tool(
  "whatsapp_send_image",
  "WhatsApp üzerinden resim gönderir",
  {
    to: z.string().describe("Alıcı"),
    imagePath: z.string().describe("Resim dosyası yolu"),
    caption: z.string().optional().describe("Resim açıklaması"),
  },
  async ({ to, imagePath, caption }) => {
    try {
      const file = validateAndReadFile(imagePath);
      if (file.error) return toolSuccess(`Hata: ${file.error}`);
      const result = await wsCall("send", {
        to, text: caption || "",
        file: { data: file.base64, filename: file.filename, mimetype: detectMimetype(file.filename!) },
      });
      return toolSuccess(`Resim gönderildi: ${result?.contactName || to}\nID: ${result?.messageId || "?"}`);
    } catch (err) { return toolError("WA send_image", err); }
  },
);

const sendDocument = tool(
  "whatsapp_send_document",
  "WhatsApp üzerinden dosya gönderir",
  {
    to: z.string().describe("Alıcı"),
    filePath: z.string().describe("Dosya yolu"),
    filename: z.string().optional().describe("Görüntülenecek dosya adı"),
  },
  async ({ to, filePath, filename: fname }) => {
    try {
      const file = validateAndReadFile(filePath);
      if (file.error) return toolSuccess(`Hata: ${file.error}`);
      const displayName = fname || file.filename!;
      const result = await wsCall("send", {
        to, text: displayName,
        file: { data: file.base64, filename: displayName, mimetype: detectMimetype(displayName) },
      });
      return toolSuccess(`Dosya gönderildi: ${result?.contactName || to}\nID: ${result?.messageId || "?"}`);
    } catch (err) { return toolError("WA send_document", err); }
  },
);

const getCalls = tool(
  "whatsapp_get_calls",
  "Arama geçmişini getirir",
  {
    chatId: z.string().optional().describe("Belirli bir kişinin aramaları"),
    limit: z.number().optional().default(20).describe("Maksimum arama sayısı"),
  },
  async ({ chatId, limit }) => {
    try {
      const calls = await wsCall("get_calls", { chatId, limit });
      if (!calls?.length) return toolSuccess("Arama kaydı bulunamadı.");
      const list = calls.map((c: any) => {
        const time = fmtTime(c.timestamp);
        const type = c.call_type === "video" ? "📹" : "📞";
        const dir = c.is_from_me ? "↗️" : "↙️";
        const dur = c.duration > 0 ? ` (${Math.floor(c.duration / 60)}:${(c.duration % 60).toString().padStart(2, "0")})` : "";
        return `[${time}] ${type} ${dir} ${c.chat_jid?.split("@")[0]} — ${c.status}${dur}`;
      });
      return toolSuccess(`Son ${calls.length} arama:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_calls", err); }
  },
);

const getReactions = tool(
  "whatsapp_get_reactions",
  "Bir mesajın veya sohbetin tepkilerini getirir",
  {
    messageId: z.string().optional().describe("Mesaj ID"),
    chatId: z.string().optional().describe("Sohbet ID"),
    limit: z.number().optional().default(50),
  },
  async ({ messageId, chatId, limit }) => {
    try {
      const reactions = await wsCall("get_reactions", { messageId, chatId, limit });
      if (!reactions?.length) return toolSuccess("Tepki bulunamadı.");
      const list = reactions.map((r: any) => `${r.emoji} — ${r.sender_jid?.split("@")[0]} (${fmtTime(r.timestamp)})`);
      return toolSuccess(`${reactions.length} tepki:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_reactions", err); }
  },
);

const react = tool(
  "whatsapp_react",
  "Bir mesaja emoji tepki verir",
  {
    chatId: z.string().describe("Sohbet ID veya kişi adı"),
    messageId: z.string().describe("Mesaj ID"),
    emoji: z.string().describe("Emoji"),
  },
  async ({ chatId, messageId, emoji }) => {
    try {
      await wsCall("react", { chatId, messageId, emoji });
      return toolSuccess(emoji ? `${emoji} tepkisi gönderildi.` : "Tepki kaldırıldı.");
    } catch (err) { return toolError("WA react", err); }
  },
);

const markRead = tool(
  "whatsapp_mark_read",
  "Mesajları okundu olarak işaretler",
  { chatId: z.string().describe("Sohbet ID veya kişi adı") },
  async ({ chatId }) => {
    try {
      await wsCall("mark_read", { chatId });
      return toolSuccess("Okundu işareti gönderildi.");
    } catch (err) { return toolError("WA mark_read", err); }
  },
);

const getPresence = tool(
  "whatsapp_get_presence",
  "Kişinin online durumunu getirir",
  { chatId: z.string().describe("Kişi ID veya isim") },
  async ({ chatId }) => {
    try {
      const result = await wsCall("get_presence", { chatId });
      return toolSuccess(`Presence: ${JSON.stringify(result)}`);
    } catch (err) { return toolError("WA get_presence", err); }
  },
);

const getNotifications = tool(
  "whatsapp_get_notifications",
  "Okunmamış WhatsApp DM bildirimlerini getirir",
  {
    limit: z.number().optional().default(20),
    markAsRead: z.boolean().optional().default(false),
  },
  async ({ limit, markAsRead }) => {
    try {
      const { notifications, stats } = await wsCall("get_notifications", { limit, markAsRead });
      if (!notifications?.length) return toolSuccess(`Okunmamış bildirim yok. (Bugün: ${stats?.today || 0})`);
      const list = notifications.map((n: any, i: number) => {
        const time = fmtTime(n.created_at);
        const typeIcon = n.message_type === "audio" ? "[Ses] " : n.message_type === "image" ? "[Resim] " : n.message_type === "video" ? "[Video] " : "";
        return `${i + 1}. [${time}] ${n.sender_name}: ${typeIcon}${n.content || ""}`.trim();
      });
      return toolSuccess(`${notifications.length} okunmamış bildirim:\n\n${list.join("\n")}${markAsRead ? "\n\n(Okundu işaretlendi)" : ""}`);
    } catch (err) { return toolError("WA get_notifications", err); }
  },
);

const watchGroup = tool(
  "whatsapp_watch_group",
  "Bir grubu izleme listesine ekler/çıkarır/listeler",
  {
    groupId: z.string().optional().describe("Grup JID veya adı"),
    action: z.enum(["add", "remove", "list"]).optional().default("list"),
  },
  async ({ groupId, action }) => {
    try {
      const result = await wsCall("watch_group", { groupId, action });
      if (action === "list") {
        if (!result?.length) return toolSuccess("İzlenen grup yok.");
        const list = result.map((g: any, i: number) => `${i + 1}. ${g.name || g.jid}`);
        return toolSuccess(`İzlenen ${result.length} grup:\n\n${list.join("\n")}`);
      }
      if (result?.added) return toolSuccess(`Grup izleme listesine eklendi: ${result.added}`);
      if (result?.removed) return toolSuccess(`Grup izleme listesinden çıkarıldı: ${result.removed}`);
      return toolSuccess(JSON.stringify(result));
    } catch (err) { return toolError("WA watch_group", err); }
  },
);

const getLabels = tool(
  "whatsapp_get_labels",
  "WhatsApp etiketlerini listeler",
  {},
  async () => {
    try {
      const labels = await wsCall("get_labels");
      if (!labels?.length) return toolSuccess("Etiket bulunamadı.");
      const list = labels.map((l: any, i: number) => `${i + 1}. ${l.name} (ID: ${l.id})`);
      return toolSuccess(`${labels.length} etiket:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_labels", err); }
  },
);

const getLabelChats = tool(
  "whatsapp_get_label_chats",
  "Belirli bir etikete sahip sohbetleri listeler",
  {
    labelId: z.string().optional().describe("Etiket ID"),
    labelName: z.string().optional().describe("Etiket adı"),
  },
  async ({ labelId, labelName }) => {
    try {
      const chats = await wsCall("get_label_chats", { labelId, labelName });
      if (!chats?.length) return toolSuccess("Bu etikete sahip sohbet bulunamadı.");
      const list = chats.map((c: any, i: number) => `${i + 1}. ${c.name || c.chat_jid}`);
      return toolSuccess(`${chats.length} sohbet:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_label_chats", err); }
  },
);

const getChatLabels = tool(
  "whatsapp_get_chat_labels",
  "Bir sohbetin etiketlerini getirir",
  { chatId: z.string().describe("Sohbet ID, numara veya isim") },
  async ({ chatId }) => {
    try {
      const labels = await wsCall("get_chat_labels", { chatId });
      if (!labels?.length) return toolSuccess("Bu sohbette etiket bulunamadı.");
      const list = labels.map((l: any) => `- ${l.name} (ID: ${l.id})`);
      return toolSuccess(`Etiketler:\n\n${list.join("\n")}`);
    } catch (err) { return toolError("WA get_chat_labels", err); }
  },
);

// ── MCP Server Factory ──────────────────────────────────────────────────

export function createWhatsAppServer() {
  return createSdkMcpServer({
    name: "whatsapp",
    version: "3.0.0",
    tools: [
      sendMessage, getChats, getMessages, getContacts, getStatus, getGroups,
      sendImage, sendDocument, getCalls, getReactions, react, markRead,
      getPresence, getNotifications, watchGroup, getLabels, getLabelChats, getChatLabels,
    ],
  });
}

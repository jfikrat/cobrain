/**
 * Gmail Tools for Cobrain Agent
 * MCP tools for Gmail operations via Google APIs
 *
 * OAuth2 flow:
 * 1. User says "Gmail'i bagla" -> agent calls gmail_auth_start
 * 2. User clicks the link, logs in with Google, grants permission
 * 3. Google redirects to /auth/gmail/callback with auth code
 * 4. We exchange code for tokens, save per-user
 * 5. All other tools use saved tokens
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { google } from "googleapis";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

// ============================================================
// OAuth2 Configuration
// ============================================================

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

interface GmailTokens {
  access_token: string | null;
  refresh_token: string | null;
  scope: string;
  token_type: string | null;
  expiry_date: number | null;
}

// In-memory cache of OAuth2 clients per user
const oauthClients = new Map<string, InstanceType<typeof google.auth.OAuth2>>();

// Helper for tool return types
function ok(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false as const };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Get OAuth2 client credentials from env or config file
 */
function getClientCredentials(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || `${process.env.WEB_URL || "http://localhost:3000"}/auth/gmail/callback`;

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Get tokens file path for a user
 */
function getTokensPath(userId: string): string {
  const basePath = process.env.COBRAIN_BASE_PATH || join(process.env.HOME || "/tmp", ".cobrain");
  const userDir = join(basePath, "users", userId);
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
  return join(userDir, "gmail-tokens.json");
}

/**
 * Save tokens for a user
 */
function saveTokens(userId: string, tokens: GmailTokens): void {
  const path = getTokensPath(userId);
  writeFileSync(path, JSON.stringify(tokens, null, 2));
}

/**
 * Load tokens for a user
 */
function loadTokens(userId: string): GmailTokens | null {
  const path = getTokensPath(userId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Get authenticated OAuth2 client for a user
 */
function getAuthClient(userId: string): InstanceType<typeof google.auth.OAuth2> | null {
  const cached = oauthClients.get(userId);
  if (cached) return cached;

  const creds = getClientCredentials();
  if (!creds) return null;

  const tokens = loadTokens(userId);
  if (!tokens) return null;

  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
  oauth2.setCredentials(tokens);

  // Auto-refresh tokens
  oauth2.on("tokens", (newTokens) => {
    const existing = loadTokens(userId);
    if (existing) {
      const merged = { ...existing, ...newTokens };
      saveTokens(userId, merged as GmailTokens);
    }
  });

  oauthClients.set(userId, oauth2);
  return oauth2;
}

/**
 * Get Gmail API instance for a user
 */
function getGmail(userId: string) {
  const auth = getAuthClient(userId);
  if (!auth) return null;
  return google.gmail({ version: "v1", auth });
}

/**
 * Handle OAuth2 callback - called from web server
 */
export async function handleGmailOAuthCallback(code: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const creds = getClientCredentials();
  if (!creds) return { success: false, error: "Google OAuth credentials not configured" };

  const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);

  try {
    const { tokens } = await oauth2.getToken(code);
    saveTokens(userId, tokens as GmailTokens);
    oauthClients.delete(userId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Token exchange failed" };
  }
}

// ============================================================
// Gmail Tools
// ============================================================

const gmailAuthStartTool = tool(
  "gmail_auth_start",
  "Gmail baglantisi baslatir. Kullaniciya Google'a giris yapmasi icin bir link verir.",
  { userId: z.string().describe("Kullanici ID") },
  async ({ userId }) => {
    const creds = getClientCredentials();
    if (!creds) return fail("Google OAuth2 credential'lari ayarlanmamis. GOOGLE_CLIENT_ID ve GOOGLE_CLIENT_SECRET env variable'lari gerekli.");

    const tokens = loadTokens(userId);
    if (tokens) return ok("Gmail zaten bagli. Yeniden baglamak istiyorsan once gmail_disconnect kullan.");

    const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret, creds.redirectUri);
    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
      state: userId,
    });

    return ok(`Gmail'i baglamak icin bu linke tikla:\n${authUrl}`);
  }
);

const gmailStatusTool = tool(
  "gmail_status",
  "Gmail baglanti durumunu kontrol eder.",
  { userId: z.string().describe("Kullanici ID") },
  async ({ userId }) => {
    const tokens = loadTokens(userId);
    if (!tokens) return ok("Gmail bagli degil. gmail_auth_start ile baglanabilirsin.");

    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail client olusturulamadi. OAuth credential'larini kontrol et.");

    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      return ok(`Gmail bagli.\nHesap: ${profile.data.emailAddress}\nToplam mesaj: ${profile.data.messagesTotal}\nThread sayisi: ${profile.data.threadsTotal}`);
    } catch (error) {
      return fail(`Gmail baglantisi bozuk: ${error instanceof Error ? error.message : "Bilinmeyen hata"}. Yeniden baglanmayi dene.`);
    }
  }
);

const gmailDisconnectTool = tool(
  "gmail_disconnect",
  "Gmail baglantisini koparir, kayitli token'lari siler.",
  { userId: z.string().describe("Kullanici ID") },
  async ({ userId }) => {
    const path = getTokensPath(userId);
    if (existsSync(path)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(path);
      oauthClients.delete(userId);
      return ok("Gmail baglantisi koparildi.");
    }
    return ok("Gmail zaten bagli degil.");
  }
);

const gmailSearchTool = tool(
  "gmail_search",
  "Gmail'de e-posta arar. Gmail arama sozdizimi destekler (from:, to:, subject:, is:unread, has:attachment, vb.).",
  {
    userId: z.string().describe("Kullanici ID"),
    query: z.string().describe("Arama sorgusu (Gmail syntax: 'from:ali subject:toplanti is:unread')"),
    maxResults: z.number().default(10).describe("Maksimum sonuc sayisi"),
  },
  async ({ userId, query, maxResults }) => {
    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail bagli degil. Once gmail_auth_start ile baglan.");

    try {
      const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
      if (!res.data.messages || res.data.messages.length === 0) return ok(`"${query}" icin sonuc bulunamadi.`);

      const messages = await Promise.all(
        res.data.messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me", id: msg.id!, format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || "";
          return {
            id: msg.id, from: getHeader("From"), to: getHeader("To"),
            subject: getHeader("Subject"), date: getHeader("Date"),
            snippet: detail.data.snippet, unread: detail.data.labelIds?.includes("UNREAD"),
          };
        })
      );

      const result = messages
        .map((m, i) => `${i + 1}. ${m.unread ? "[OKUNMAMIS] " : ""}${m.subject}\n   Kimden: ${m.from}\n   Tarih: ${m.date}\n   ${m.snippet}\n   ID: ${m.id}`)
        .join("\n\n");

      return ok(`${messages.length} sonuc:\n\n${result}`);
    } catch (error) {
      return fail(`Arama hatasi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const gmailReadTool = tool(
  "gmail_read",
  "Belirli bir e-postayi okur (tam icerik).",
  {
    userId: z.string().describe("Kullanici ID"),
    messageId: z.string().describe("Mesaj ID (gmail_search'ten alinir)"),
  },
  async ({ userId, messageId }) => {
    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail bagli degil.");

    try {
      const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const headers = msg.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || "";

      let body = "";
      const payload = msg.data.payload;

      if (payload?.body?.data) {
        body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
      } else if (payload?.parts) {
        const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
        const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
        const part = textPart || htmlPart;
        if (part?.body?.data) body = Buffer.from(part.body.data, "base64url").toString("utf-8");

        if (!body) {
          for (const p of payload.parts) {
            if (p.parts) {
              const nested = p.parts.find((np) => np.mimeType === "text/plain");
              if (nested?.body?.data) { body = Buffer.from(nested.body.data, "base64url").toString("utf-8"); break; }
            }
          }
        }
      }

      if (body.includes("<html") || body.includes("<div")) {
        body = body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      }
      if (body.length > 3000) body = body.substring(0, 3000) + "\n... (kisaltildi)";

      const attachments = (payload?.parts || [])
        .filter((p) => p.filename && p.filename.length > 0)
        .map((p) => `- ${p.filename} (${p.mimeType})`);

      let result = `Konu: ${getHeader("Subject")}\nKimden: ${getHeader("From")}\nKime: ${getHeader("To")}\nTarih: ${getHeader("Date")}\n\n${body}`;
      if (attachments.length > 0) result += `\n\nEkler:\n${attachments.join("\n")}`;

      return ok(result);
    } catch (error) {
      return fail(`Okuma hatasi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const gmailSendTool = tool(
  "gmail_send",
  "E-posta gonderir.",
  {
    userId: z.string().describe("Kullanici ID"),
    to: z.string().describe("Alici e-posta adresi"),
    subject: z.string().describe("Konu"),
    body: z.string().describe("E-posta icerigi (duz metin)"),
    cc: z.string().optional().describe("CC alicilari (virgullu ayir)"),
    bcc: z.string().optional().describe("BCC alicilari"),
    replyTo: z.string().optional().describe("Yanitlanacak mesaj ID"),
  },
  async ({ userId, to, subject, body, cc, bcc, replyTo }) => {
    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail bagli degil.");

    try {
      let headers = `To: ${to}\nSubject: ${subject}\nContent-Type: text/plain; charset=utf-8\n`;
      if (cc) headers += `Cc: ${cc}\n`;
      if (bcc) headers += `Bcc: ${bcc}\n`;

      let threadId: string | undefined;
      if (replyTo) {
        const original = await gmail.users.messages.get({
          userId: "me", id: replyTo, format: "metadata", metadataHeaders: ["Message-ID", "Subject"],
        });
        const msgIdHeader = original.data.payload?.headers?.find((h) => h.name === "Message-ID")?.value;
        if (msgIdHeader) headers += `In-Reply-To: ${msgIdHeader}\nReferences: ${msgIdHeader}\n`;
        threadId = original.data.threadId || undefined;
      }

      const message = `${headers}\n${body}`;
      const encodedMessage = Buffer.from(message).toString("base64url");

      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encodedMessage, threadId },
      });

      return ok(`E-posta gonderildi. ID: ${res.data.id}`);
    } catch (error) {
      return fail(`Gonderme hatasi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const gmailLabelsTool = tool(
  "gmail_labels",
  "Gmail etiketlerini listeler.",
  { userId: z.string().describe("Kullanici ID") },
  async ({ userId }) => {
    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail bagli degil.");

    try {
      const res = await gmail.users.labels.list({ userId: "me" });
      const labels = (res.data.labels || []).map((l) => `- ${l.name} (${l.type}) [${l.id}]`).join("\n");
      return ok(`Etiketler:\n${labels}`);
    } catch (error) {
      return fail(`Etiket hatasi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const gmailModifyTool = tool(
  "gmail_modify",
  "E-posta etiketlerini degistirir (arsivle, okundu/okunmadi isaretle, yildizla, vb.).",
  {
    userId: z.string().describe("Kullanici ID"),
    messageId: z.string().describe("Mesaj ID"),
    addLabels: z.array(z.string()).default([]).describe("Eklenecek etiketler (orn: ['STARRED', 'IMPORTANT'])"),
    removeLabels: z.array(z.string()).default([]).describe("Kaldirilacak etiketler (orn: ['UNREAD', 'INBOX'])"),
  },
  async ({ userId, messageId, addLabels, removeLabels }) => {
    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail bagli degil.");

    try {
      await gmail.users.messages.modify({
        userId: "me", id: messageId,
        requestBody: {
          addLabelIds: addLabels.length > 0 ? addLabels : undefined,
          removeLabelIds: removeLabels.length > 0 ? removeLabels : undefined,
        },
      });
      const actions: string[] = [];
      if (addLabels.length > 0) actions.push(`Eklendi: ${addLabels.join(", ")}`);
      if (removeLabels.length > 0) actions.push(`Kaldirildi: ${removeLabels.join(", ")}`);
      return ok(`Mesaj guncellendi. ${actions.join(". ")}`);
    } catch (error) {
      return fail(`Guncelleme hatasi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const gmailInboxTool = tool(
  "gmail_inbox",
  "Gelen kutusu ozeti: okunmamis sayisi ve son e-postalar.",
  {
    userId: z.string().describe("Kullanici ID"),
    maxResults: z.number().default(5).describe("Gosterilecek son e-posta sayisi"),
  },
  async ({ userId, maxResults }) => {
    const gmail = getGmail(userId);
    if (!gmail) return fail("Gmail bagli degil.");

    try {
      const unreadRes = await gmail.users.messages.list({ userId: "me", q: "is:unread", maxResults: 1 });
      const unreadCount = unreadRes.data.resultSizeEstimate || 0;

      const inboxRes = await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults });
      if (!inboxRes.data.messages || inboxRes.data.messages.length === 0) {
        return ok(`Gelen kutusu bos. Okunmamis: ${unreadCount}`);
      }

      const messages = await Promise.all(
        inboxRes.data.messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me", id: msg.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || "";
          const unread = detail.data.labelIds?.includes("UNREAD");
          return `${unread ? "[OKUNMAMIS] " : ""}${getHeader("Subject")}\n  Kimden: ${getHeader("From")} | ${getHeader("Date")}\n  ID: ${msg.id}`;
        })
      );

      return ok(`Okunmamis: ${unreadCount}\n\nSon ${messages.length} e-posta:\n\n${messages.join("\n\n")}`);
    } catch (error) {
      return fail(`Inbox hatasi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

// ============================================================
// MCP Server Factory
// ============================================================

export function createGmailServer(userId: string) {
  return createSdkMcpServer({
    name: "cobrain-gmail",
    version: "1.0.0",
    tools: [
      gmailAuthStartTool,
      gmailStatusTool,
      gmailDisconnectTool,
      gmailSearchTool,
      gmailReadTool,
      gmailSendTool,
      gmailLabelsTool,
      gmailModifyTool,
      gmailInboxTool,
    ],
  });
}

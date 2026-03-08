/**
 * Gmail Tools for Cobrain Agent
 * MCP tools using Gmail REST API with per-user OAuth tokens
 * Token stored at ~/.cobrain/users/{userId}/gmail-tokens.json
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { join } from "node:path";
import { userManager } from "../../services/user-manager.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GmailToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // ms timestamp
  token_type: string;
  scope: string;
}

/**
 * Load and auto-refresh token for userId
 */
async function getToken(userId: number): Promise<string> {
  const tokenPath = join(userManager.getUserFolder(userId), "gmail-tokens.json");
  const file = Bun.file(tokenPath);

  if (!(await file.exists())) {
    throw new Error("Gmail token not found. Authorize with the /gmail command.");
  }

  const token: GmailToken = await file.json();

  // Refresh if expired (with 60s buffer)
  if (Date.now() >= token.expiry_date - 60_000) {
    // Prefer credentials embedded in token file (Desktop app client)
    const clientId = (token as GmailToken & { client_id?: string }).client_id || process.env.GOOGLE_CLIENT_ID;
    const clientSecret = (token as GmailToken & { client_secret?: string }).client_secret || process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID/SECRET missing");

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);
    const fresh = await resp.json() as { access_token: string; expires_in: number };

    token.access_token = fresh.access_token;
    token.expiry_date = Date.now() + fresh.expires_in * 1000;
    await Bun.write(tokenPath, JSON.stringify(token, null, 2));
  }

  return token.access_token;
}

/**
 * Gmail API helper
 */
async function gmailGet(userId: number, path: string, params?: Record<string, string | string[]>) {
  const token = await getToken(userId);
  const url = new URL(`${GMAIL_API}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        v.forEach(val => url.searchParams.append(k, val));
      } else {
        url.searchParams.set(k, v);
      }
    });
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

async function gmailPost(userId: number, path: string, body: unknown) {
  const token = await getToken(userId);
  const resp = await fetch(`${GMAIL_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Parse email headers into a readable object
 */
function parseHeaders(headers: Array<{ name: string; value: string }>) {
  const h: Record<string, string> = {};
  for (const { name, value } of headers) {
    h[name.toLowerCase()] = value;
  }
  return h;
}

/**
 * Extract plain text body from message payload
 */
function extractBody(payload: {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: unknown[];
}): string {
  if (!payload) return "";

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8").slice(0, 2000);
  }

  // Multipart — find text/plain first, then text/html
  if (payload.parts && Array.isArray(payload.parts)) {
    const parts = payload.parts as Array<{
      mimeType?: string;
      body?: { data?: string };
      parts?: unknown[];
    }>;

    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8").slice(0, 2000);
      }
    }
    for (const part of parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64").toString("utf-8");
        // Strip HTML tags for readability
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
      }
    }
  }

  return "(Content could not be read)";
}

// ========== TOOLS ==========

export const gmailInboxTool = (userId: number) =>
  tool(
    "gmail_inbox",
    "List the Gmail inbox. Use for unread or recent emails.",
    {
      query: z.string().default("is:unread").describe("Gmail search query (e.g. 'is:unread', 'from:ali', 'is:important')"),
      limit: z.number().min(1).max(20).default(10).describe("How many emails to show (max 20)"),
    },
    async ({ query, limit }) => {
      try {
        const data = await gmailGet(userId, "/messages", {
          q: query,
          maxResults: String(limit),
          labelIds: "INBOX",
        }) as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number };

        if (!data.messages?.length) {
          return { content: [{ type: "text" as const, text: `No emails found for "${query}".` }] };
        }

        // Fetch snippet + headers for each message
        const summaries = await Promise.all(
          data.messages.map(async (msg) => {
            const detail = await gmailGet(userId, `/messages/${msg.id}`, {
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date"],
            }) as {
              id: string;
              snippet: string;
              payload: { headers: Array<{ name: string; value: string }> };
              labelNames?: string[];
            };

            const h = parseHeaders(detail.payload?.headers ?? []);
            const from = h.from?.replace(/<[^>]+>/, "").trim() || "?";
            const subject = h.subject || "(No subject)";
            const date = h.date ? new Date(h.date).toLocaleDateString("en-US") : "?";
            const snippet = detail.snippet?.slice(0, 100) || "";

            return `📧 **${subject}**\n   From: ${from} | ${date}\n   ${snippet}...\n   ID: \`${msg.id}\``;
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: `📬 Gmail (${data.resultSizeEstimate ?? data.messages.length} results, showing ${limit}):\n\n${summaries.join("\n\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Gmail error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

export const gmailReadTool = (userId: number) =>
  tool(
    "gmail_read",
    "Read a specific Gmail message in full.",
    {
      messageId: z.string().describe("Message ID (from gmail_inbox)"),
    },
    async ({ messageId }) => {
      try {
        const data = await gmailGet(userId, `/messages/${messageId}`, {
          format: "full",
        }) as {
          id: string;
          snippet: string;
          payload: {
            headers: Array<{ name: string; value: string }>;
            mimeType?: string;
            body?: { data?: string };
            parts?: unknown[];
          };
        };

        const h = parseHeaders(data.payload.headers);
        const body = extractBody(data.payload);

        return {
          content: [{
            type: "text" as const,
            text: [
              `📧 **${h.subject || "(No subject)"}**`,
              `From: ${h.from || "?"}`,
              `To: ${h.to || "?"}`,
              `Date: ${h.date ? new Date(h.date).toLocaleString("en-US") : "?"}`,
              ``,
              body,
            ].join("\n"),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Could not read email: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

export const gmailSearchTool = (userId: number) =>
  tool(
    "gmail_search",
    "Search Gmail. Supports Gmail search operators.",
    {
      query: z.string().describe("Search query (e.g. 'from:ali invoice', 'subject:meeting', 'after:2026/02/01')"),
      limit: z.number().min(1).max(10).default(5).describe("Result count"),
    },
    async ({ query, limit }) => {
      try {
        const data = await gmailGet(userId, "/messages", {
          q: query,
          maxResults: String(limit),
        }) as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };

        if (!data.messages?.length) {
          return { content: [{ type: "text" as const, text: `No results found for "${query}".` }] };
        }

        const summaries = await Promise.all(
          data.messages.map(async (msg) => {
            const detail = await gmailGet(userId, `/messages/${msg.id}`, {
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date"],
            }) as {
              id: string;
              snippet: string;
              payload: { headers: Array<{ name: string; value: string }> };
            };

            const h = parseHeaders(detail.payload?.headers ?? []);
            const date = h.date ? new Date(h.date).toLocaleDateString("en-US") : "?";
            return `• **${h.subject || "(No subject)"}** — ${h.from?.replace(/<[^>]+>/, "").trim()} (${date})\n  ${detail.snippet?.slice(0, 120)}...\n  ID: \`${msg.id}\``;
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: `🔍 "${query}" — ${data.resultSizeEstimate ?? data.messages.length} results:\n\n${summaries.join("\n\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Search error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

export const gmailSendTool = (userId: number) =>
  tool(
    "gmail_send",
    "Send an email via Gmail.",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC addresses (comma-separated)"),
    },
    async ({ to, subject, body, cc }) => {
      try {
        // Build RFC 2822 message
        const lines = [
          `To: ${to}`,
          cc ? `Cc: ${cc}` : null,
          `Subject: ${subject}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          body,
        ].filter(Boolean).join("\r\n");

        const encoded = Buffer.from(lines).toString("base64url");

        await gmailPost(userId, "/messages/send", { raw: encoded });

        return {
          content: [{
            type: "text" as const,
            text: `✅ Email sent: "${subject}" → ${to}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to send email: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

export const gmailReplyTool = (userId: number) =>
  tool(
    "gmail_reply",
    "Reply to an existing email. Finds the original by messageId and adds to the thread.",
    {
      messageId: z.string().describe("ID of the email to reply to (from gmail_inbox)"),
      body: z.string().describe("Reply body (plain text)"),
    },
    async ({ messageId, body }) => {
      try {
        // Get the original email - for Message-ID, thread, and sender
        const original = await gmailGet(userId, `/messages/${messageId}`, {
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Message-ID", "References"],
        }) as {
          id: string;
          threadId: string;
          payload: { headers: Array<{ name: string; value: string }> };
        };

        const h = parseHeaders(original.payload?.headers ?? []);
        const replyTo = h.from || "";
        const subject = h.subject?.startsWith("Re:") ? h.subject : `Re: ${h.subject || ""}`;
        const messageIdHeader = h["message-id"] || "";
        const references = h["references"] ? `${h["references"]} ${messageIdHeader}` : messageIdHeader;

        const lines = [
          `To: ${replyTo}`,
          `Subject: ${subject}`,
          `In-Reply-To: ${messageIdHeader}`,
          references ? `References: ${references}` : null,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          body,
        ].filter(Boolean).join("\r\n");

        const encoded = Buffer.from(lines).toString("base64url");

        await gmailPost(userId, "/messages/send", {
          raw: encoded,
          threadId: original.threadId,
        });

        return {
          content: [{
            type: "text" as const,
            text: `✅ Reply sent: "${subject}" → ${replyTo}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to send reply: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

// ========== SERVER ==========

export function createGmailServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-gmail",
    version: "1.0.0",
    tools: [
      gmailInboxTool(userId),
      gmailReadTool(userId),
      gmailSearchTool(userId),
      gmailSendTool(userId),
      gmailReplyTool(userId),
    ],
  });
}

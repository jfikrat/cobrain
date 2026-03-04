/**
 * WA Agent — Bağımsız Agent SDK Chat
 *
 * Cobrain HTTP API yerine doğrudan Agent SDK kullanır.
 * - In-memory session (1h TTL)
 * - MCP: memory, time, whatsapp (doğrudan outbox)
 * - Max 5 turn, 2 retry
 * - Sub-agent yok
 */

import {
  query,
  tool,
  createSdkMcpServer,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { createMemoryServerFromPath } from "../../agent/tools/memory.ts";
import { getTimeServer } from "../../agent/tools/time.ts";
import { toolSuccess, toolError } from "../../utils/tool-response.ts";

// ── Config ───────────────────────────────────────────────────────────────

const WA_MODEL = process.env.WA_AGENT_MODEL || "claude-sonnet-4-6";
const MAX_TURNS = 5;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1000, 3000];
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const USER_FOLDER = process.env.COBRAIN_USER_FOLDER || `${process.env.HOME}/.cobrain/users/${process.env.MY_TELEGRAM_ID}`;

// ── Session Store ────────────────────────────────────────────────────────

interface SessionEntry {
  sessionId: string;
  lastUsed: number;
}

const sessions = new Map<string, SessionEntry>();

function getSession(key: string): string | undefined {
  const entry = sessions.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > SESSION_TTL_MS) {
    sessions.delete(key);
    return undefined;
  }
  return entry.sessionId;
}

function setSession(key: string, sessionId: string) {
  sessions.set(key, { sessionId, lastUsed: Date.now() });
}

// Cleanup stale sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL_MS) sessions.delete(key);
  }
}, 30 * 60 * 1000);

// ── WhatsApp Send Tool (doğrudan outbox DB) ─────────────────────────────

const WA_DB_PATH = process.env.WHATSAPP_DB_PATH || "/home/fjds/projects/whatsapp/db/whatsapp.db";

let waDb: Database | null = null;

function getWaDb(): Database | null {
  if (waDb) return waDb;
  try {
    waDb = new Database(WA_DB_PATH);
    waDb.run("PRAGMA journal_mode = WAL");
    return waDb;
  } catch (err) {
    console.error("[WA SDK] DB bağlanamadı:", err);
    return null;
  }
}

const sendWhatsAppTool = tool(
  "send_whatsapp_message",
  "WhatsApp mesajı gönder. Kişinin telefon numarasını veya JID'ini ver.",
  {
    to: z.string().describe("Alıcı telefon numarası (ör: 905551234567) veya JID (ör: 905551234567@s.whatsapp.net)"),
    message: z.string().describe("Gönderilecek mesaj metni"),
  },
  async ({ to, message }) => {
    try {
      const db = getWaDb();
      if (!db) return toolError("DB bağlantısı yok", new Error("WA DB unavailable"));

      const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
      const result = db.run(
        `INSERT INTO outbox (chat_jid, content, status, created_at) VALUES (?, ?, 'pending', datetime('now'))`,
        [jid, message],
      );
      console.log(`[WA SDK] Outbox'a yazıldı: ${jid} (#${result.lastInsertRowid})`);
      return toolSuccess(`Mesaj gönderildi: ${jid} (outbox #${result.lastInsertRowid})`);
    } catch (error) {
      return toolError("Mesaj gönderilemedi", error);
    }
  }
);

function createWaSendServer() {
  return createSdkMcpServer({
    name: "wa-send",
    version: "1.0.0",
    tools: [sendWhatsAppTool],
  });
}

// ── MCP Servers (lazy init, shared) ──────────────────────────────────────

let memoryServer: ReturnType<typeof createMemoryServerFromPath> | null = null;
let timeServer: ReturnType<typeof getTimeServer> | null = null;
let waSendServer: ReturnType<typeof createWaSendServer> | null = null;

function getMemoryMcp() {
  if (!memoryServer) memoryServer = createMemoryServerFromPath(USER_FOLDER);
  return memoryServer;
}

function getTimeMcp() {
  if (!timeServer) timeServer = getTimeServer();
  return timeServer;
}

function getWaSendMcp() {
  if (!waSendServer) waSendServer = createWaSendServer();
  return waSendServer;
}

// ── Retry Logic ──────────────────────────────────────────────────────────

const RETRYABLE_PATTERNS = ["Internal server error", "overloaded", "rate limit", "529", "500"];

function isRetryableError(message: string): boolean {
  return RETRYABLE_PATTERNS.some(p => message.toLowerCase().includes(p.toLowerCase()));
}

// ── Public API ───────────────────────────────────────────────────────────

export interface WaChatResponse {
  content: string;
  sessionId: string;
  toolsUsed: string[];
  numTurns: number;
}

export interface WaChatOptions {
  /** Her tool çağrısında tetiklenir */
  onToolUse?: (toolName: string) => void;
}

export async function waChat(
  prompt: string,
  sessionKey: string,
  systemPrompt: string,
  options?: WaChatOptions,
): Promise<WaChatResponse> {
  return _execute(prompt, sessionKey, systemPrompt, 1, options);
}

// ── Internal ─────────────────────────────────────────────────────────────

async function _execute(
  prompt: string,
  sessionKey: string,
  systemPrompt: string,
  attempt: number,
  options?: WaChatOptions,
): Promise<WaChatResponse> {
  const existingSessionId = getSession(sessionKey);
  const toolsUsed: string[] = [];
  let lastAssistantContent = "";
  let sessionId = "";
  let numTurns = 0;

  try {
    const queryResult = query({
      prompt,
      options: {
        model: WA_MODEL,
        systemPrompt,
        resume: existingSessionId,
        maxTurns: MAX_TURNS,

        mcpServers: {
          memory: getMemoryMcp(),
          time: getTimeMcp(),
          whatsapp: getWaSendMcp(),
        },

        // Tool logging + auto-approve hooks — no permission/notifier
        hooks: {
          PreToolUse: [
            {
              hooks: [
                (hookInput: any) => {
                  const toolName = hookInput.tool_name;
                  toolsUsed.push(toolName);
                  console.log(`[WA SDK] Tool: ${toolName}`);
                  options?.onToolUse?.(toolName);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "allow" as const,
                    },
                  };
                },
              ],
            },
          ],
        },
      },
    });

    for await (const msg of queryResult) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            sessionId = msg.session_id;
            setSession(sessionKey, sessionId);
            console.log(`[WA SDK] Session: ${sessionId.slice(0, 8)}... (key: ${sessionKey})`);
          }
          break;

        case "assistant": {
          // Extract text content from assistant message
          const content = msg.message?.content;
          if (typeof content === "string") {
            lastAssistantContent = content;
          } else if (Array.isArray(content)) {
            const textParts = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text);
            if (textParts.length > 0) lastAssistantContent = textParts.join("");
          }
          break;
        }

        case "result": {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success") {
            numTurns = result.num_turns;
            if (!lastAssistantContent && result.result) {
              lastAssistantContent = result.result;
            }
          } else {
            console.error(`[WA SDK] Error: ${result.subtype}`, (result as any).errors);
            if (!lastAssistantContent) {
              lastAssistantContent = `Hata: ${result.subtype}`;
            }
          }
          break;
        }
      }
    }

    console.log(`[WA SDK] Done: ${numTurns} turns, ${toolsUsed.length} tools`);

    return {
      content: lastAssistantContent || "",
      sessionId,
      toolsUsed: [...new Set(toolsUsed)],
      numTurns,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Stale session — clear and retry once
    if (existingSessionId && errorMessage.includes("exited with code")) {
      console.warn(`[WA SDK] Stale session, retrying fresh...`);
      sessions.delete(sessionKey);
      return _execute(prompt, sessionKey, systemPrompt, attempt, options);
    }

    // Retry on transient API errors
    if (attempt <= MAX_RETRIES && isRetryableError(errorMessage)) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 3000;
      console.warn(`[WA SDK] Retry ${attempt}/${MAX_RETRIES} in ${delay}ms: ${errorMessage.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, delay));
      return _execute(prompt, sessionKey, systemPrompt, attempt + 1, options);
    }

    console.error("[WA SDK] Chat error:", error);

    // Clear session on error
    sessions.delete(sessionKey);

    return {
      content: "",
      sessionId: "",
      toolsUsed: [],
      numTurns: 0,
    };
  }
}

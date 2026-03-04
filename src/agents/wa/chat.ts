/**
 * WA Agent — Bağımsız Agent SDK Chat
 *
 * Cobrain HTTP API yerine doğrudan Agent SDK kullanır.
 * - In-memory session (1h TTL)
 * - MCP: memory, time, gateway
 * - Max 5 turn, 2 retry
 * - Sub-agent yok
 */

import {
  query,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createMemoryServerFromPath } from "../../agent/tools/memory.ts";
import { getTimeServer } from "../../agent/tools/time.ts";

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

// ── MCP Servers (lazy init, shared) ──────────────────────────────────────

let memoryServer: ReturnType<typeof createMemoryServerFromPath> | null = null;
let timeServer: ReturnType<typeof getTimeServer> | null = null;

function getMemoryMcp() {
  if (!memoryServer) memoryServer = createMemoryServerFromPath(USER_FOLDER);
  return memoryServer;
}

function getTimeMcp() {
  if (!timeServer) timeServer = getTimeServer();
  return timeServer;
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

export async function waChat(
  prompt: string,
  sessionKey: string,
  systemPrompt: string,
): Promise<WaChatResponse> {
  return _execute(prompt, sessionKey, systemPrompt, 1);
}

// ── Internal ─────────────────────────────────────────────────────────────

async function _execute(
  prompt: string,
  sessionKey: string,
  systemPrompt: string,
  attempt: number,
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
          gateway: {
            type: "stdio" as const,
            command: "bun",
            args: ["run", "/home/fjds/projects/gateway/src/index.ts"],
          },
        },

        // Tool logging hooks only — no permission/notifier
        hooks: {
          PreToolUse: [
            ({ tool_name }) => {
              toolsUsed.push(tool_name);
              console.log(`[WA SDK] Tool: ${tool_name}`);
              return undefined; // auto-approve
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
      return _execute(prompt, sessionKey, systemPrompt, attempt);
    }

    // Retry on transient API errors
    if (attempt <= MAX_RETRIES && isRetryableError(errorMessage)) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 3000;
      console.warn(`[WA SDK] Retry ${attempt}/${MAX_RETRIES} in ${delay}ms: ${errorMessage.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, delay));
      return _execute(prompt, sessionKey, systemPrompt, attempt + 1);
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

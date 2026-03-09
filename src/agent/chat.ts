/**
 * Cobrain Agent Chat
 * Main chat function - using Claude Agent SDK
 * v0.4 - MD-based System Prompt
 */

import {
  query,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { userManager } from "../services/user-manager.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { readMindFiles, buildMdSystemPrompt, type DynamicContext } from "./prompts.ts";
import { getMoodTrackingService } from "../services/mood-tracking.ts";
import { FileMemory } from "../memory/file-memory.ts";
import { getSessionState, updateSessionState, detectTopic, detectPhase } from "../services/session-state.ts";
import { UserMemory } from "../memory/sqlite.ts";
import { config } from "../config.ts";
import { join } from "node:path";
import { DEFAULT_TIMEZONE, DEFAULT_LOCALE } from "../constants.ts";

// Split modules
import { getMemoryServer, getTelegramMcpServer, getAgentLoopServer } from "./mcp-servers.ts";
import { createMemoryServerFromPath } from "./tools/memory.ts";
import { extractTextContent, buildMessageContent, type MultimodalMessage } from "./message-builder.ts";
import { createPreToolUseHooks, ToolStreamNotifier } from "./hooks.ts";

// Re-export types from message-builder for backwards compatibility
export type { MultimodalMessage, ImageContent, TextContent, MessageContent } from "./message-builder.ts";

export interface ChatResponse {
  content: string;
  sessionId: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  toolsUsed: string[];
  model: string;
  stopReason: string | null;
}

// Session cache per user — stores sessionId + last touch timestamp
interface CachedSession { id: string; touchedAt: number; }
const userSessions = new Map<number, CachedSession>();

// Session cache for named cortex sessions (e.g. "wa_cortex")
const cortexSessions = new Map<string, CachedSession>();

export interface ChatOptions {
  /** System prompt override for WA cortex or other sub-cortex agents */
  systemPromptOverride?: string;
  /** Separate session cache key (e.g. "wa_cortex"). Undefined = main Cobrain session */
  sessionKey?: string;
  /** Channel the message came from: "telegram" | "api" | "wa" */
  channel?: string;
  /** If true, ToolStreamNotifier (Telegram notifications) is disabled */
  silent?: boolean;
  /**
   * For hub-agent topic messages: tool notifications are posted to this chat/thread.
   * If not provided, they are sent to userId (DM). Ignored when silent=true.
   */
  notifierTarget?: { chatId: number; threadId: number };
  /** Agent working directory - if provided, memory is read from and written to this directory */
  workDir?: string;
  /** Agent name - shown in the ToolStreamNotifier header */
  agentName?: string;
}

// Concurrency guard: ref-count of active _executeChat calls per user.
// Multiple parallel sessions (hub agents) increment/decrement independently.
const activeThinking = new Map<number, number>();

// Per-session serialization queue: keyed sessions (hub agents) get independent lanes,
// main user sessions serialize on "user:{userId}".
const pendingChats = new Map<string, Promise<ChatResponse>>();

export function isUserBusy(userId: number): boolean {
  return (activeThinking.get(userId) ?? 0) > 0;
}

// Idle threshold: if session has been idle longer than this,
// prepend a time-gap note so the agent knows time has passed.
const IDLE_BOUNDARY_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SessionLookup {
  sessionId: string;
  idleMs: number;
}

async function getOrResumeCortexSession(
  userId: number,
  sessionKey: string,
): Promise<SessionLookup | undefined> {
  // 1. In-memory cache
  const cached = cortexSessions.get(sessionKey);
  if (cached) return { sessionId: cached.id, idleMs: Date.now() - cached.touchedAt };

  // 2. DB lookup (no TTL — sessions are permanent until /clear)
  try {
    const userDb = await userManager.getUserDb(userId);
    const memory = new UserMemory(userDb);
    const session = memory.getSessionByKey(sessionKey);
    if (!session?.lastUsedAt) return undefined;

    const idleMs = Date.now() - new Date(session.lastUsedAt).getTime();
    console.log(`[Cortex] Resuming keyed session ${sessionKey} from DB (${Math.round(idleMs / 60000)}min idle)`);
    cortexSessions.set(sessionKey, { id: session.id, touchedAt: Date.now() - idleMs });
    return { sessionId: session.id, idleMs };
  } catch (e) {
    console.warn("[Cortex] Keyed session DB lookup failed:", e);
    return undefined;
  }
}

async function getOrResumeSession(userId: number): Promise<SessionLookup | undefined> {
  // 1. In-memory cache (process lifetime)
  const cached = userSessions.get(userId);
  if (cached) return { sessionId: cached.id, idleMs: Date.now() - cached.touchedAt };

  // 2. Last active session from DB (no TTL — sessions are permanent until /clear)
  try {
    const userDb = await userManager.getUserDb(userId);
    const memory = new UserMemory(userDb);
    const session = memory.getSession();
    if (!session?.lastUsedAt) return undefined;

    const idleMs = Date.now() - new Date(session.lastUsedAt).getTime();
    console.log(`[Cortex] Resuming session from DB (${Math.round(idleMs / 60000)}min idle)`);
    userSessions.set(userId, { id: session.id, touchedAt: Date.now() - idleMs });
    return { sessionId: session.id, idleMs };
  } catch (e) {
    console.warn("[Cortex] Session DB lookup failed:", e);
    return undefined;
  }
}

/**
 * Main chat function using Agent SDK
 * Serializes concurrent calls per user to prevent session corruption.
 */
export function chat(
  userId: number,
  message: string | MultimodalMessage,
  traceId?: string,
  modelOverride?: string,
  options?: ChatOptions,
): Promise<ChatResponse> {
  // Serialization key: keyed sessions (hub agents) get their own lane,
  // so they don't block each other or the main Cobrain session.
  const queueKey = options?.sessionKey ?? `user:${userId}`;
  const prev = pendingChats.get(queueKey);
  const current: Promise<ChatResponse> = (prev?.catch(() => undefined) ?? Promise.resolve(undefined))
    .then(() => _executeChat(userId, message, traceId, modelOverride, 1, options));
  pendingChats.set(queueKey, current);
  current.finally(() => {
    if (pendingChats.get(queueKey) === current) pendingChats.delete(queueKey);
  });
  return current;
}

const RETRYABLE_PATTERNS = ["Internal server error", "overloaded", "rate limit", "529", "500"];
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 3000, 8000];

function isRetryableError(message: string): boolean {
  return RETRYABLE_PATTERNS.some((p) => message.toLowerCase().includes(p.toLowerCase()));
}

/**
 * Direct chat execution — bypasses per-user serialization queue.
 * Used by agent_delegate to avoid deadlock (parent chat waits for delegation,
 * delegation waits for queue → deadlock).
 */
export async function _executeChat(
  userId: number,
  message: string | MultimodalMessage,
  traceId?: string,
  modelOverride?: string,
  attempt = 1,
  options?: ChatOptions,
): Promise<ChatResponse> {
  activeThinking.set(userId, (activeThinking.get(userId) ?? 0) + 1);
  try {
  // Ensure user exists and get settings
  await userManager.ensureUser(userId);
  const settings = await userManager.getUserSettings(userId);
  const userFolder = userManager.getUserFolder(userId);

  // Build dynamic context (time + mood + recent memories)
  const dynamicTime = buildTimeContext();

  let dynamicMood: DynamicContext['mood'] = undefined;
  try {
    const moodService = await getMoodTrackingService(userId);
    const current = moodService.getCurrentMood();
    const trend = moodService.getMoodTrend(7);
    if (current) {
      dynamicMood = {
        current: current.mood,
        energy: current.energy,
        trend: trend.direction,
      };
    }
  } catch {}

  // Load recent memories from file-based system
  let recentMemories: string[] = [];
  const queryText = typeof message === 'string' ? message : message.text || '';

  try {
    const memoryRoot = options?.workDir || userFolder;
    const fileMemory = new FileMemory(memoryRoot);
    const q = queryText.toLowerCase();

    const facts = await fileMemory.readFacts();
    const events = await fileMemory.readRecentEvents(30);

    // Simple relevance: lines containing query keywords
    const keywords = q.split(/\s+/).filter((w: string) => w.length > 2);
    const allLines = [...facts.split("\n"), ...events.split("\n")];
    const relevant = keywords.length > 0
      ? allLines.filter(l => keywords.some((k: string) => l.toLowerCase().includes(k)) && l.trim() && !l.startsWith("#"))
      : [];

    // Fallback: just include facts if no relevant lines
    if (relevant.length === 0 && facts.trim()) {
      recentMemories = [facts.slice(0, 400)];
    } else {
      recentMemories = deduplicateMemories(relevant.slice(0, 5).map(l => l.trim()));
    }
  } catch (e) {
    console.warn("[Cortex] File memory read failed:", e);
  }

  // Session state for continuity
  let sessionState: DynamicContext['sessionState'] = undefined;
  if (config.FF_SESSION_STATE) {
    try {
      const state = getSessionState(userId);
      if (state.lastTopic) {
        sessionState = {
          lastTopic: state.lastTopic,
          topicContext: state.topicContext,
          pendingActions: state.pendingActions,
          conversationPhase: state.conversationPhase,
          lastUserMessage: state.lastUserMessage,
        };
      }
    } catch (e) {
      console.warn("[Cortex] Session state load failed:", e);
    }
  }

  // Hub agent awareness — only for main Cobrain, not sub-cortex
  let hubAgents: DynamicContext['hubAgents'] = undefined;
  if (config.COBRAIN_HUB_ID && !options?.systemPromptOverride) {
    try {
      const { buildHubAgentContext } = await import("../agents/hub-context.ts");
      hubAgents = await buildHubAgentContext(userFolder);
    } catch {}
  }

  let systemPrompt: string;
  if (options?.systemPromptOverride) {
    // Sub-cortex (WA cortex etc.) passes its own system prompt
    systemPrompt = options.systemPromptOverride;
  } else {
    const mindContent = await readMindFiles(userFolder);
    systemPrompt = buildMdSystemPrompt(mindContent, {
      time: dynamicTime,
      mood: dynamicMood,
      recentMemories,
      sessionState,
      hubAgents,
      channel: options?.channel,
    });
  }

  // Preserve original message text before any mutation (for session state persistence)
  const originalMessageText = typeof message === "string" ? message : message.text || "";

  // Get or resume session (no TTL — sessions are permanent until /clear)
  const sessionLookup = options?.sessionKey
    ? await getOrResumeCortexSession(userId, options.sessionKey)
    : await getOrResumeSession(userId);
  const existingSessionId = sessionLookup?.sessionId;
  const sessionIdleMs = sessionLookup?.idleMs ?? 0;

  // Idle boundary: if session resumed after long idle, prepend time-gap note
  if (existingSessionId && sessionIdleMs > IDLE_BOUNDARY_MS) {
    const idleHours = Math.round(sessionIdleMs / (60 * 60 * 1000));
    const idleNote = `[System note: ${idleHours}h have passed since last interaction. The user is returning after a break.]`;
    if (typeof message === "string") {
      message = `${idleNote}\n\n${message}`;
    } else {
      message = { ...message, text: `${idleNote}\n\n${message.text}` };
    }
  }

  // Track tools used + streaming notifier (silent mode = no Telegram notifications)
  const toolsUsed: string[] = [];
  const notifier = options?.silent
    ? null
    : options?.notifierTarget
      ? new ToolStreamNotifier(userId, options.notifierTarget.chatId, options.notifierTarget.threadId, options.agentName)
      : new ToolStreamNotifier(userId);
  let lastAssistantContent = "";
  let sessionId = "";
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;
  let stopReason: string | null = null;

  // Build the message content (text or multimodal)
  const messageContent = buildMessageContent(message);
  const messagePreview = typeof message === "string" ? message.slice(0, 50) : message.text.slice(0, 50);
  const hasImages = typeof message !== "string" && message.images && message.images.length > 0;

  const actualModel = modelOverride || config.AGENT_MODEL;

  console.log(`[Cortex] Chat started for user ${userId}: "${messagePreview}..."${hasImages ? " (with images)" : ""}${modelOverride ? ` (model: ${actualModel})` : ""}`);

  try {
    // Create the prompt - use SDKUserMessage for multimodal content
    const prompt = hasImages
      ? (async function* () {
          yield {
            type: "user" as const,
            message: {
              role: "user" as const,
              content: messageContent,
            },
            parent_tool_use_id: null,
            session_id: existingSessionId || "",
          };
        })()
      : (typeof message === "string" ? message : message.text);

    const hooks = {
      PreToolUse: createPreToolUseHooks({
        userId,
        toolsUsed,
        traceId,
        permissionMode: settings.permissionMode || config.PERMISSION_MODE,
        notifier,
      }),
    };

    const subAgents = undefined;

    const queryResult = query({
      prompt,
      options: {
        // Model: override from router-lite or fallback to config
        model: actualModel,

        // Working directory - user's folder
        cwd: userFolder,

        // System prompt with Cobrain persona
        systemPrompt,

        // Resume previous session if exists
        resume: existingSessionId,

        // Load project instructions (user-folder CLAUDE.md and its @refs)
        // Firecrawl skill lives in userFolder/.claude/skills/firecrawl-cli/
        // Custom skills: Cobrain writes to userFolder/.claude/skills/ — auto-discovered.
        settingSources: ["project"],

        // Allow Skill tool to run without permission prompts
        allowedTools: ["Skill"],

        // Disable ToolSearch — it defers all MCP tools and causes infinite loops
        // when agent tries to load them via tool_reference. Without ToolSearch,
        // SDK loads all MCP tools upfront into the context.
        disallowedTools: ["ToolSearch"],

        // MCP Servers (createSdkMcpServer returns full config)
        mcpServers: {
          memory: options?.workDir ? createMemoryServerFromPath(options.workDir) : getMemoryServer(userId),
          telegram: getTelegramMcpServer(),
          agentLoop: getAgentLoopServer(),
          // Gateway - all external services (whatsapp, calendar, gmail, helm, squad, etc.)
          gateway: {
            type: "stdio" as const,
            command: "bun",
            args: ["run", join(config.MCP_SERVERS_HOME, "gateway", "src", "index.ts")],
          },
        },

        ...(subAgents ? { agents: subAgents } : {}),

        // Hooks for logging and permission control
        hooks,

        // Limit turns to prevent runaway
        maxTurns: config.MAX_AGENT_TURNS,

      },
    });

    // Process messages
    for await (const msg of queryResult) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            sessionId = msg.session_id;
            if (options?.sessionKey) {
              cortexSessions.set(options.sessionKey, { id: sessionId, touchedAt: Date.now() });
              // DB persist for cross-restart recovery
              try {
                const userDb = await userManager.getUserDb(userId);
                new UserMemory(userDb).setSessionByKey(options.sessionKey, sessionId);
              } catch (e) {
                console.warn(`[Cortex] Keyed session persist failed:`, e);
              }
            } else {
              userSessions.set(userId, { id: sessionId, touchedAt: Date.now() });
              // Persist to DB for cross-restart recovery
              try {
                const userDb = await userManager.getUserDb(userId);
                const mem = new UserMemory(userDb);
                mem.setSession(sessionId);
              } catch (e) {
                console.warn(`[Cortex] Session persist failed:`, e);
              }
            }
            console.log(`[Cortex] Session${options?.sessionKey ? ` (${options.sessionKey})` : ""}: ${sessionId.slice(0, 8)}...`);
          }
          break;

        case "assistant":
          lastAssistantContent = extractTextContent(msg);
          break;

        case "result":
          const result = msg as SDKResultMessage;
          stopReason = result.stop_reason ?? null;
          if (result.subtype === "success") {
            totalCost = result.total_cost_usd;
            inputTokens = result.usage.input_tokens;
            outputTokens = result.usage.output_tokens;
            numTurns = result.num_turns;

            // Use result text if no assistant message captured
            if (!lastAssistantContent && result.result) {
              lastAssistantContent = result.result;
            }
          } else {
            // Error case
            console.error(`[Cortex] Error: ${result.subtype} (stop: ${stopReason})`, (result as any).errors);
            if (!lastAssistantContent) {
              lastAssistantContent = `An error occurred: ${result.subtype}`;
            }
          }
          break;
      }
    }

    console.log(
      `[Cortex] Completed: ${numTurns} turns, ${toolsUsed.length} tools, $${totalCost.toFixed(4)}` +
      (stopReason && stopReason !== "end_turn" ? ` [stop: ${stopReason}]` : "")
    );

    // Finalize streaming notification
    if (notifier) await notifier.complete({ cost: totalCost, stopReason });

    // Heartbeat: agent completed successfully
    heartbeat("ai_agent", { event: "completed", turns: numTurns, tools: toolsUsed.length, cost: totalCost });

    // Touch session in DB after successful completion (update last_used_at)
    try {
      const userDb = await userManager.getUserDb(userId);
      const mem = new UserMemory(userDb);
      mem.touchSession(sessionId);
    } catch {}

    // Update in-memory cache touchedAt
    if (options?.sessionKey) {
      cortexSessions.set(options.sessionKey, { id: sessionId, touchedAt: Date.now() });
    } else {
      userSessions.set(userId, { id: sessionId, touchedAt: Date.now() });
    }

    // Session state: write conversation context (use original message, not idle-boundary-mutated one)
    if (config.FF_SESSION_STATE) {
      try {
        const detected = detectTopic(originalMessageText, lastAssistantContent);
        const phaseDetected = detectPhase(lastAssistantContent);

        updateSessionState(userId, {
          lastUserMessage: originalMessageText.slice(0, 500),
          lastInteractionTime: Date.now(),
          ...(detected && { lastTopic: detected }),
          ...(phaseDetected && phaseDetected.confidence > 0.7 && {
            conversationPhase: phaseDetected.phase,
            confidence: phaseDetected.confidence,
          }),
        });
      } catch {}
    }

    return {
      content: lastAssistantContent || "No response received.",
      sessionId,
      totalCost,
      inputTokens,
      outputTokens,
      numTurns,
      toolsUsed: [...new Set(toolsUsed)], // Unique tools
      model: actualModel,
      stopReason,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Stale session from DB — SDK can't find it after restart
    // Clear and retry once with a fresh session (call _executeChat directly to avoid queue deadlock)
    if (existingSessionId && errorMessage.includes("exited with code")) {
      console.warn(`[Cortex] Stale session detected, retrying with fresh session...`);
      if (options?.sessionKey) {
        cortexSessions.delete(options.sessionKey);
        try {
          const userDb = await userManager.getUserDb(userId);
          new UserMemory(userDb).clearSessionByKey(options.sessionKey);
        } catch {}
      } else {
        userSessions.delete(userId);
        try {
          const userDb = await userManager.getUserDb(userId);
          const mem = new UserMemory(userDb);
          mem.clearSession();
        } catch {}
      }
      return _executeChat(userId, message, traceId, modelOverride, attempt, options);
    }

    // Retry on transient API errors (500, overloaded, rate limit)
    if (attempt <= MAX_RETRIES && isRetryableError(errorMessage)) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 8000;
      console.warn(`[Cortex] API error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${errorMessage.slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, delay));
      const rc = (activeThinking.get(userId) ?? 1) - 1;
      if (rc <= 0) activeThinking.delete(userId);
      else activeThinking.set(userId, rc);
      return _executeChat(userId, message, traceId, modelOverride, attempt + 1, options);
    }

    console.error("[Cortex] Chat error:", error);

    // Finalize streaming notification with error
    if (notifier) await notifier.complete({ error: errorMessage });

    // Clear session on error to start fresh next time
    if (options?.sessionKey) {
      cortexSessions.delete(options.sessionKey);
      try {
        const userDb = await userManager.getUserDb(userId);
        new UserMemory(userDb).clearSessionByKey(options.sessionKey);
      } catch {}
    } else {
      userSessions.delete(userId);
    }

    return {
      content: `Error: ${errorMessage}`,
      sessionId: "",
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
      toolsUsed: [],
      model: actualModel,
      stopReason: null,
    };
  }
  } finally {
    const count = (activeThinking.get(userId) ?? 1) - 1;
    if (count <= 0) activeThinking.delete(userId);
    else activeThinking.set(userId, count);
  }
}

/**
 * Clear user session
 */
export function clearSession(userId: number): void {
  userSessions.delete(userId);
  console.log(`[Cortex] Session cleared for user ${userId}`);
}

/**
 * Get session info
 */
export function getSessionInfo(userId: number): { sessionId: string | null } {
  return {
    sessionId: userSessions.get(userId)?.id || null,
  };
}


/**
 * Deduplicate memories with similar content.
 * Uses a simple prefix-match heuristic: if two memories share
 * the first 60 characters, keep only the first (most recent).
 */
function deduplicateMemories(memories: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const mem of memories) {
    const key = mem.slice(0, 60).toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mem);
  }
  return result;
}

/**
 * Build time context for dynamic prompt injection
 */
function buildTimeContext(): DynamicContext['time'] {
  const now = new Date();
  const hour = now.getHours();
  const dayPart = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const isWeekend = [0, 6].includes(now.getDay());
  const formatted = now.toLocaleDateString(DEFAULT_LOCALE, {
    day: "2-digit",
    month: "long",
    year: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: DEFAULT_TIMEZONE,
  });
  return { now: formatted, dayPart, isWeekend };
}

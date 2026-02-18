/**
 * Cobrain Agent Chat
 * Ana chat fonksiyonu - Claude Agent SDK kullanarak
 * v0.3 - Dynamic Persona System
 */

import {
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { userManager } from "../services/user-manager.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { readMindFiles, buildMdSystemPrompt, type DynamicContext } from "./prompts.ts";
import { getMoodTrackingService } from "../services/mood-tracking.ts";
import { SmartMemory } from "../memory/smart-memory.ts";
import { getSessionState, updateSessionState, detectTopic, detectPhase } from "../services/session-state.ts";
import { UserMemory } from "../memory/sqlite.ts";
import { config } from "../config.ts";
import type { MemorySearchResult } from "../types/memory.ts";
import type { MemoryEntry } from "../types/memory.ts";

// Split modules
import { getMemoryServer, getTelegramMcpServer, getGoalsServer, getMoodServer, getLocationServer, getTimeServer } from "./mcp-servers.ts";
import { extractTextContent, buildMessageContent, type MultimodalMessage } from "./message-builder.ts";
import { createPreToolUseHooks, createPreCompactHook } from "./hooks.ts";

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
}

// Session ID cache per user
const userSessions = new Map<number, string>();

// Concurrency guard: reflects whether _executeChat is actively running
const activeThinking = new Set<number>();

// Per-user serialization queue: ensures chat() calls run one at a time per user
const pendingChats = new Map<number, Promise<ChatResponse>>();

function isUserBusy(userId: number): boolean {
  return activeThinking.has(userId);
}

// Session TTL: 2 hours - after this, start a fresh session
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

async function getOrResumeSession(userId: number): Promise<string | undefined> {
  // 1. In-memory cache (process lifetime)
  const cached = userSessions.get(userId);
  if (cached) return cached;

  // 2. DB'den son aktif session
  try {
    const userDb = await userManager.getUserDb(userId);
    const memory = new UserMemory(userDb);
    const session = memory.getSession();
    if (!session?.lastUsedAt) return undefined;

    // 3. TTL kontrolü (gece 23-08 arası 3x tolerans)
    const age = Date.now() - new Date(session.lastUsedAt).getTime();
    const hour = new Date().getHours();
    const effectiveTTL = hour >= 23 || hour < 8 ? SESSION_TTL_MS * 3 : SESSION_TTL_MS;
    if (age > effectiveTTL) {
      console.log(`[Cortex] Session expired (${Math.round(age / 60000)}min), starting fresh`);
      return undefined;
    }

    console.log(`[Cortex] Resuming session from DB (${Math.round(age / 60000)}min old)`);
    userSessions.set(userId, session.id);
    return session.id;
  } catch {
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
): Promise<ChatResponse> {
  // Chain on the previous pending call so calls are strictly serialized per user
  const prev = pendingChats.get(userId);
  const current: Promise<ChatResponse> = (prev?.catch(() => undefined) ?? Promise.resolve(undefined))
    .then(() => _executeChat(userId, message, traceId, modelOverride));
  pendingChats.set(userId, current);
  // Clean up map entry once resolved (avoid memory leak for long-running processes)
  current.finally(() => {
    if (pendingChats.get(userId) === current) pendingChats.delete(userId);
  });
  return current;
}

async function _executeChat(
  userId: number,
  message: string | MultimodalMessage,
  traceId?: string,
  modelOverride?: string,
): Promise<ChatResponse> {
  activeThinking.add(userId);
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

  // Token budget: max 5 memories, query-relevant + importance, deduplicated
  let recentMemories: string[] = [];
  try {
    const memory = new SmartMemory(userFolder, userId);
    const now = Date.now();

    // Query-relevant memories (hybrid search)
    const queryText = typeof message === 'string' ? message : (message as any).text || '';
    let queryRelevant: MemorySearchResult[] = [];
    try {
      queryRelevant = await memory.search(queryText, { limit: 3, minScore: 0.3 });
    } catch {}

    // Importance-based (reduced)
    const important = memory.getByImportance(2, 0.7);

    // Merge + deduplicate by id, cap at 5
    const seenIds = new Set<number>();
    const merged: MemoryEntry[] = [];
    for (const entry of [...queryRelevant, ...important]) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      merged.push(entry);
      if (merged.length >= 5) break;
    }

    // Format with recency & importance labels
    recentMemories = deduplicateMemories(
      merged.map(e => {
        const daysAgo = Math.floor((now - new Date(e.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        return `[${daysAgo}d ago, imp=${e.importance.toFixed(1)}] ${truncate(e.content, 180)}`;
      })
    );
    memory.close();
  } catch {}

  // Session state for continuity
  let sessionState: DynamicContext['sessionState'] = undefined;
  let recentWhatsApp: DynamicContext['recentWhatsApp'] = undefined;
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
      // WhatsApp context — token budget: max 5 notifications, preview truncated to 150 chars
      if (state.recentWhatsApp.length > 0) {
        const now = Date.now();
        recentWhatsApp = state.recentWhatsApp
          .filter(n => now - n.timestamp < 24 * 60 * 60 * 1000)
          .slice(-5) // keep only 5 most recent
          .map(n => ({
            senderName: n.senderName,
            preview: truncate(n.preview, 150),
            tier: n.tier,
            autoReply: n.autoReply ? truncate(n.autoReply, 100) : undefined,
            isGroup: n.isGroup,
            minutesAgo: Math.round((now - n.timestamp) / 60000),
          }));
        if (recentWhatsApp.length === 0) recentWhatsApp = undefined;
      }
    } catch {}
  }

  const mindContent = await readMindFiles(userFolder);
  const systemPrompt = buildMdSystemPrompt(mindContent, {
    time: dynamicTime,
    mood: dynamicMood,
    recentMemories,
    sessionState,
    recentWhatsApp,
  });

  // Get or resume session (checks in-memory cache, then DB with TTL)
  const existingSessionId = await getOrResumeSession(userId);

  // Track tools used
  const toolsUsed: string[] = [];
  let lastAssistantContent = "";
  let sessionId = "";
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;

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
      }),
      ...(config.MINIMAL_AUTONOMY ? {} : { PreCompact: createPreCompactHook(userId) }),
    };

    const subAgents = config.MINIMAL_AUTONOMY
      ? undefined
      : {
          // Sub-agents of Cortex (main agent) — brain-themed names
          frontal: {
            description: "Web'de araştırma yapar, bilgi toplar. Güncel bilgi, haber, teknik dokümantasyon aramak için kullan.",
            prompt: "Sen Cortex'in araştırma sub-agent'ısın (Frontal). Verilen konuyu web'de araştır, güvenilir kaynaklardan bilgi topla ve özet sun. Türkçe yanıt ver.",
            tools: ["WebSearch", "WebFetch"],
          },
          wernicke: {
            description: "Uzun metinleri özetler ve analiz eder. Makale, döküman, konuşma özeti için kullan.",
            prompt: "Sen Cortex'in dil ve anlam sub-agent'ısın (Wernicke). Verilen metni kısa, öz ve anlaşılır şekilde özetle. Önemli noktaları vurgula. Türkçe yanıt ver.",
          },
          hippocampus: {
            description: "Kullanıcının hafızasında arama ve analiz yapar. Geçmiş konuşmalar, kaydedilen bilgiler için kullan.",
            prompt: "Sen Cortex'in hafıza sub-agent'ısın (Hippocampus). Kullanıcının hafızasında detaylı arama yap, ilgili bilgileri bul ve özetle. Türkçe yanıt ver.",
            tools: ["mcp__memory__recall", "mcp__memory__memory_stats"],
          },
        };

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

        // MCP Servers (createSdkMcpServer returns full config)
        mcpServers: {
          memory: getMemoryServer(userId),
          goals: getGoalsServer(userId),
          telegram: getTelegramMcpServer(),
          time: getTimeServer(),
          mood: getMoodServer(userId),
          location: getLocationServer(userId),
          // Gateway - helm, squad, whatsapp via single MCP gateway
          gateway: {
            type: "stdio" as const,
            command: "bun",
            args: ["run", "/home/fjds/projects/gateway/src/index.ts"],
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
            userSessions.set(userId, sessionId);
            // Persist to DB for cross-restart recovery
            try {
              const userDb = await userManager.getUserDb(userId);
              const mem = new UserMemory(userDb);
              mem.setSession(sessionId);
            } catch (e) {
              console.warn(`[Cortex] Session persist failed:`, e);
            }
            console.log(`[Cortex] Session: ${sessionId.slice(0, 8)}...`);
          }
          break;

        case "assistant":
          lastAssistantContent = extractTextContent(msg);
          break;

        case "result":
          const result = msg as SDKResultMessage;
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
            console.error(`[Cortex] Error: ${result.subtype}`, (result as any).errors);
            if (!lastAssistantContent) {
              lastAssistantContent = `Bir hata oluştu: ${result.subtype}`;
            }
          }
          break;
      }
    }

    console.log(
      `[Cortex] Completed: ${numTurns} turns, ${toolsUsed.length} tools, $${totalCost.toFixed(4)}`
    );

    // Heartbeat: agent completed successfully
    heartbeat("ai_agent", { event: "completed", turns: numTurns, tools: toolsUsed.length, cost: totalCost });

    // Session state: write conversation context
    if (config.FF_SESSION_STATE) {
      try {
        const userMsg = typeof message === "string" ? message : message.text || "";
        const detected = detectTopic(userMsg, lastAssistantContent);
        const phaseDetected = detectPhase(lastAssistantContent);

        updateSessionState(userId, {
          lastUserMessage: userMsg.slice(0, 500),
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
      content: lastAssistantContent || "Yanıt alınamadı.",
      sessionId,
      totalCost,
      inputTokens,
      outputTokens,
      numTurns,
      toolsUsed: [...new Set(toolsUsed)], // Unique tools
      model: actualModel,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Stale session from DB — SDK can't find it after restart
    // Clear and retry once with a fresh session (call _executeChat directly to avoid queue deadlock)
    if (existingSessionId && errorMessage.includes("exited with code")) {
      console.warn(`[Cortex] Stale session detected, retrying with fresh session...`);
      userSessions.delete(userId);
      try {
        const userDb = await userManager.getUserDb(userId);
        const mem = new UserMemory(userDb);
        mem.clearSession();
      } catch {}
      return _executeChat(userId, message, traceId, modelOverride);
    }

    console.error("[Cortex] Chat error:", error);

    // Clear session on error to start fresh next time
    userSessions.delete(userId);

    return {
      content: `Hata: ${errorMessage}`,
      sessionId: "",
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
      toolsUsed: [],
      model: actualModel,
    };
  }
  } finally {
    activeThinking.delete(userId);
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
    sessionId: userSessions.get(userId) || null,
  };
}

// ========== Token Budget Helpers ==========

/** Truncate string to maxLen, appending "..." if trimmed */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
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
  const dayPart = hour < 6 ? "gece" : hour < 12 ? "sabah" : hour < 18 ? "öğle" : "akşam";
  const isWeekend = [0, 6].includes(now.getDay());
  const formatted = now.toLocaleDateString("tr-TR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  });
  return { now: formatted, dayPart, isWeekend };
}

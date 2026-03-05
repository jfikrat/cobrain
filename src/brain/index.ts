/**
 * Brain module - AI chat logic with per-user memory
 * Cobrain v0.3 - Agent SDK based
 */

import { UserMemory, type Message } from "../memory/sqlite.ts";
import { isHaikuAvailable } from "../services/haiku.ts";
import { userManager } from "../services/user-manager.ts";
import { config } from "../config.ts";
import { chat as agentChat, clearSession as agentClearSession, type MultimodalMessage } from "../agent/index.ts";

import { generateTraceId } from "../types/brain-events.ts";
import { getEventStore } from "./event-store.ts";

// Session state persistence
import { updateSessionState, detectPhase, detectTopic } from "../services/session-state.ts";

export interface ThinkResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId: string;
  historyLength: number;
  memoriesUsed: number;
}

// Cache for UserMemory instances
const userMemories = new Map<number, UserMemory>();

/**
 * Get or create UserMemory for a specific user
 */
async function getUserMemory(userId: number): Promise<UserMemory> {
  let memory = userMemories.get(userId);
  if (memory) return memory;

  const db = await userManager.getUserDb(userId);
  memory = new UserMemory(db);
  userMemories.set(userId, memory);

  return memory;
}

/**
 * Process user message and generate AI response
 * Supports both text-only and multimodal (with images) messages
 */
export async function think(userId: number, message: string | MultimodalMessage, channel: string = "telegram"): Promise<ThinkResponse> {
  const traceId = generateTraceId();
  const startMs = Date.now();
  const textMessage = typeof message === "string" ? message : message.text;
  const hasImage = typeof message !== "string" && (message.images?.length ?? 0) > 0;

  // Event: user message received
  const eventStore = config.FF_BRAIN_EVENTS ? getEventStore() : null;
  if (eventStore) {
    eventStore.append({
      userId,
      traceId,
      eventType: "message.user.received",
      channel,
      actor: "user",
      payload: { preview: textMessage.slice(0, 100), hasImage },
    });
  }

  // Always use primary model
  const route = { model: config.AGENT_MODEL, level: "deep" as const, reason: "primary" };

  if (eventStore) {
    eventStore.append({
      userId,
      traceId,
      eventType: "route.decision",
      actor: "system",
      payload: { level: route.level, model: route.model, reason: route.reason },
    });
  }

  try {
    let response: ThinkResponse;

    response = await thinkWithAgentSDK(userId, message, traceId, channel);

    // Event: completed
    if (eventStore) {
      eventStore.append({
        userId,
        traceId,
        eventType: "agent.run.completed",
        actor: "agent",
        payload: {
          numTurns: response.historyLength,
          model: config.AGENT_MODEL,
          routeLevel: route.level,
        },
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        latencyMs: Date.now() - startMs,
      });
    }

    // Session state update (after response)
    if (config.FF_SESSION_STATE && !config.MINIMAL_AUTONOMY) {
      try {
        const detectedPhase = detectPhase(response.content);
        const detectedTopic = detectTopic(textMessage, response.content);
        const updates: Record<string, unknown> = {
          lastUserMessage: textMessage.slice(0, 200),
        };
        if (detectedTopic) updates.lastTopic = detectedTopic;
        if (detectedPhase) {
          updates.conversationPhase = detectedPhase.phase;
          updates.confidence = detectedPhase.confidence;
        }
        updateSessionState(userId, updates as any);
      } catch (err) {
        console.warn(`[Brain] Session state update failed:`, err);
      }
    }

    return response;
  } catch (error) {
    // Event: failed
    if (eventStore) {
      eventStore.append({
        userId,
        traceId,
        eventType: "agent.run.failed",
        actor: "agent",
        payload: {
          error: error instanceof Error ? error.message : String(error),
          routeLevel: route.level,
        },
        latencyMs: Date.now() - startMs,
      });
    }
    throw error;
  }
}

/**
 * Agent SDK based chat (new)
 * Supports multimodal messages with images
 */
async function thinkWithAgentSDK(
  userId: number,
  message: string | MultimodalMessage,
  traceId?: string,
  channel?: string,
): Promise<ThinkResponse> {
  const hasImages = typeof message !== "string" && message.images && message.images.length > 0;
  const textMessage = typeof message === "string" ? message : message.text;
  console.log(`[Brain] Using Agent SDK for user ${userId}${hasImages ? " (with images)" : ""}`);

  const response = await agentChat(userId, message, traceId, undefined, channel ? { channel } : undefined);

  // Save messages to database (like CLI mode does)
  try {
    const memory = await getUserMemory(userId);

    // Ensure we have a session
    let sessionId = memory.getSessionId();
    if (!sessionId) {
      sessionId = response.sessionId || crypto.randomUUID();
      memory.setSession(sessionId);
    }

    // Save user message
    memory.addMessage("user", textMessage, {
      tokensIn: response.inputTokens,
      metadata: { hasImages, agentSdk: true },
    });

    // Save assistant response
    memory.addMessage("assistant", response.content, {
      tokensOut: response.outputTokens,
      costUsd: response.totalCost,
      metadata: { toolsUsed: response.toolsUsed },
    });

    memory.incrementSessionMessageCount();
  } catch (error) {
    console.warn(`[Brain] Failed to save messages to DB: ${error}`);
  }

  return {
    content: response.content,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.totalCost,
    sessionId: response.sessionId,
    historyLength: response.numTurns,
    memoriesUsed: response.toolsUsed.filter((t) => t === "remember" || t === "recall").length,
  };
}

/**
 * Clear user's session and history
 */
export async function clearSession(userId: number): Promise<void> {
  agentClearSession(userId);
  console.log(`[Session] Session temizlendi (user: ${userId})`);
}

/**
 * Get user's message history
 */
export async function getHistory(userId: number, limit?: number): Promise<Message[]> {
  const memory = await getUserMemory(userId);
  return memory.getHistory(limit ?? config.MAX_HISTORY);
}

/**
 * Get user's stats
 */
export async function getStats(userId: number): Promise<{
  messageCount: number;
  sessionCount: number;
  totalCost: number;
  memoryCount: number;
}> {
  const memory = await getUserMemory(userId);
  const basicStats = memory.getStats();

  return {
    ...basicStats,
    memoryCount: 0,
  };
}

/**
 * Check if smart memory (Haiku) is available
 */
export async function isVectorMemoryAvailable(): Promise<boolean> {
  return isHaikuAvailable();
}

/**
 * Close all memory connections
 */
export async function closeAll(): Promise<void> {
  for (const memory of userMemories.values()) {
    memory.close();
  }
  userMemories.clear();

  userManager.close();
}

// Re-exports
export { userManager };
export type { Message, MultimodalMessage };

/**
 * Brain module - AI chat logic with per-user memory
 * Cobrain v0.3 - Agent SDK based (with CLI fallback)
 */

import { ClaudeSessionManager, type ClaudeMessage } from "../services/claude-session.ts";
import { UserMemory, type Message } from "../memory/sqlite.ts";
import { SmartMemory } from "../memory/smart-memory.ts";
import { initHaiku, isHaikuAvailable } from "../services/haiku.ts";
import { userManager } from "../services/user-manager.ts";
import { config } from "../config.ts";
import type { MemorySearchResult, MemoryInput } from "../types/memory.ts";

// Agent SDK imports
import { chat as agentChat, clearSession as agentClearSession, closeAllMemories, type MultimodalMessage } from "../agent/index.ts";

// Initialize Haiku on module load (for fallback CLI mode)
if (!config.USE_AGENT_SDK) {
  initHaiku();
}

// Initialize Claude Session Manager (tmux-based)
// Uses per-user folders so each user gets their own CLAUDE.md context
const claudeSessionManager = new ClaudeSessionManager(
  process.env.COBRAIN_WORK_DIR || process.cwd(),
  (userId: number) => userManager.getUserFolder(userId)
);

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
const smartMemories = new Map<number, SmartMemory>();

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
 * Get or create SmartMemory for a specific user
 */
async function getSmartMemory(userId: number): Promise<SmartMemory> {
  let smartMemory = smartMemories.get(userId);
  if (smartMemory) return smartMemory;

  const userFolder = userManager.getUserFolder(userId);
  smartMemory = new SmartMemory(userFolder, userId);
  smartMemories.set(userId, smartMemory);

  return smartMemory;
}

/**
 * Search for relevant memories and format as context
 */
async function getMemoryContext(userId: number, message: string): Promise<{ context: string; memories: MemorySearchResult[] }> {
  try {
    console.log(`[Memory] Searching for: "${message.slice(0, 50)}..." (user: ${userId})`);
    const smartMemory = await getSmartMemory(userId);
    const memories = await smartMemory.search(message, {
      limit: 3,
      minScore: 0.4,
    });

    if (memories.length === 0) {
      console.log(`[Memory] No relevant memories found (user: ${userId})`);
      return { context: "", memories: [] };
    }

    const contextLines = memories.map((m) => {
      const summary = m.summary || m.content.slice(0, 150);
      return `- ${summary}`;
    });

    const context = `\n\n[İlgili hatıralar]\n${contextLines.join("\n")}`;

    console.log(`[Memory] ${memories.length} ilgili hafıza bulundu (user: ${userId})`);

    return { context, memories };
  } catch (error) {
    console.warn(`[Memory] Search error: ${error}`);
    return { context: "", memories: [] };
  }
}

/**
 * Process user message and generate AI response
 * Supports both text-only and multimodal (with images) messages
 */
export async function think(userId: number, message: string | MultimodalMessage): Promise<ThinkResponse> {
  // Use Agent SDK if enabled
  if (config.USE_AGENT_SDK) {
    return thinkWithAgentSDK(userId, message);
  }

  // Fallback to CLI mode (only supports text)
  const textMessage = typeof message === "string" ? message : message.text;
  return thinkWithCLI(userId, textMessage);
}

/**
 * Agent SDK based chat (new)
 * Supports multimodal messages with images
 */
async function thinkWithAgentSDK(userId: number, message: string | MultimodalMessage): Promise<ThinkResponse> {
  const hasImages = typeof message !== "string" && message.images && message.images.length > 0;
  const textMessage = typeof message === "string" ? message : message.text;
  console.log(`[Brain] Using Agent SDK for user ${userId}${hasImages ? " (with images)" : ""}`);

  const response = await agentChat(userId, message);

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
 * CLI based chat (legacy fallback)
 */
async function thinkWithCLI(userId: number, message: string): Promise<ThinkResponse> {
  const memory = await getUserMemory(userId);

  // Get or create session ID for tracking
  let sessionId = memory.getSessionId();
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    memory.setSession(sessionId);
    console.log(`[Session] Yeni session oluşturuldu: ${sessionId.slice(0, 8)}... (user: ${userId})`);
  }

  // Search for relevant memories
  const { context, memories } = await getMemoryContext(userId, message);

  // Add memory context to message if available
  const enrichedMessage = context ? `${message}${context}` : message;

  // Call Claude via tmux session
  const response = await claudeSessionManager.chat(userId, enrichedMessage);

  // Save to per-user history
  memory.addMessage("user", message, {
    tokensIn: 0, // tmux mode doesn't track tokens
    metadata: { memoriesUsed: memories.length },
  });

  memory.addMessage("assistant", response.content, {
    tokensOut: 0,
    costUsd: 0,
  });

  memory.incrementSessionMessageCount();

  // Try to extract and store important info from conversation
  try {
    const smartMemory = await getSmartMemory(userId);
    await smartMemory.extractAndStore(
      [
        { role: "user", content: message },
        { role: "assistant", content: response.content },
      ],
      sessionId
    );
  } catch (error) {
    // Silently fail - extraction is optional
    console.warn(`[Memory] Extraction failed: ${error}`);
  }

  const history = memory.getHistory(config.MAX_HISTORY);

  return {
    content: response.content,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    sessionId,
    historyLength: history.length,
    memoriesUsed: memories.length,
  };
}

/**
 * Clear user's session and history
 */
export async function clearSession(userId: number): Promise<void> {
  if (config.USE_AGENT_SDK) {
    agentClearSession(userId);
  } else {
    const memory = await getUserMemory(userId);
    memory.clearSession();
    memory.clearHistory();

    // Also stop the Claude tmux session
    await claudeSessionManager.stopSession(userId);
  }

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

  let memoryCount = 0;
  try {
    const smartMemory = await getSmartMemory(userId);
    const memoryStats = smartMemory.getStats();
    memoryCount = memoryStats.total;
  } catch {
    // Smart memory not available
  }

  return {
    ...basicStats,
    memoryCount,
  };
}

/**
 * Store a memory manually
 */
export async function storeMemory(userId: number, input: MemoryInput): Promise<number> {
  const smartMemory = await getSmartMemory(userId);
  return smartMemory.store(input);
}

/**
 * Search memories
 */
export async function searchMemories(
  userId: number,
  query: string,
  limit?: number
): Promise<MemorySearchResult[]> {
  const smartMemory = await getSmartMemory(userId);
  return smartMemory.search(query, { limit: limit ?? 5, minScore: 0.3 });
}

/**
 * Get recent memories
 */
export async function getRecentMemories(userId: number, limit?: number) {
  const smartMemory = await getSmartMemory(userId);
  return smartMemory.getRecent(limit ?? 10);
}

/**
 * Get memory stats
 */
export async function getMemoryStats(userId: number) {
  const smartMemory = await getSmartMemory(userId);
  return smartMemory.getStats();
}

/**
 * Prune expired memories
 */
export async function pruneMemories(userId: number): Promise<number> {
  const smartMemory = await getSmartMemory(userId);
  return smartMemory.prune();
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
  // Close Agent SDK memories
  if (config.USE_AGENT_SDK) {
    closeAllMemories();
  }

  // Stop all Claude tmux sessions (for CLI mode)
  if (!config.USE_AGENT_SDK) {
    await claudeSessionManager.stopAll();
  }

  for (const memory of userMemories.values()) {
    memory.close();
  }
  userMemories.clear();

  for (const smartMemory of smartMemories.values()) {
    smartMemory.close();
  }
  smartMemories.clear();

  userManager.close();
}

// Re-exports
export { userManager, claudeSessionManager };
export type { Message, ClaudeMessage, MemorySearchResult, MultimodalMessage };

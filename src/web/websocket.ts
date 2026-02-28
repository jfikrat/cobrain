/**
 * WebSocket Message Handler
 * Streaming chat with Agent SDK
 */

import type { ServerWebSocket } from "bun";
import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { userManager } from "../services/user-manager.ts";
import { generatePersonaSystemPrompt } from "../agent/prompts.ts";
import { getMemoryServer, getGoalsServer, getPersonaServer, getGDriveServer, getTelegramMcpServer } from "../agent/mcp-servers.ts";
import { getPersonaService } from "../services/persona.ts";
import { needsPermission, type PermissionMode } from "../agent/permissions.ts";
import { config } from "../config.ts";

// ============ Types ============

export interface WebSocketData {
  userId: number;
  sessionId: string | null;
  connectedAt: number;
}

// Client -> Server messages
interface ChatAttachment {
  id: string;
  type: "image" | "audio" | "document";
}

interface ChatMessage {
  type: "chat";
  payload: {
    message: string;
    attachments?: ChatAttachment[];
  };
}

interface CancelMessage {
  type: "cancel";
}

interface PingMessage {
  type: "ping";
}

interface SyncConversationsMessage {
  type: "sync_conversations";
  payload: { lastSyncAt: number | null };
}

interface SaveMessageMessage {
  type: "save_message";
  payload: {
    conversationId: string;
    message: {
      id: string;
      role: "user" | "assistant";
      content: string;
      toolUses?: unknown[];
      attachments?: unknown[];
      timestamp: number;
    };
  };
}

interface CreateConversationMessage {
  type: "create_conversation";
  payload: { id: string; title: string; createdAt: number };
}

interface DeleteConversationMessage {
  type: "delete_conversation";
  payload: { id: string };
}

interface UpdateConversationTitleMessage {
  type: "update_conversation_title";
  payload: { id: string; title: string };
}

type ClientMessage =
  | ChatMessage
  | CancelMessage
  | PingMessage
  | SyncConversationsMessage
  | SaveMessageMessage
  | CreateConversationMessage
  | DeleteConversationMessage
  | UpdateConversationTitleMessage;

// Server -> Client messages
interface ConnectedMessage {
  type: "connected";
  payload: { sessionId: string | null };
}

interface TextDeltaMessage {
  type: "text_delta";
  payload: { delta: string; fullText: string };
}

interface ToolUseMessage {
  type: "tool_use";
  payload: { tool: { name: string; input: unknown } };
}

interface ToolResultMessage {
  type: "tool_result";
  payload: { toolResult: { name: string; status: "success" | "error"; output?: string } };
}

interface ChatEndMessage {
  type: "chat_end";
  payload: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    };
    toolsUsed: string[];
  };
}

interface ErrorMessage {
  type: "error";
  payload: { error: string };
}

interface PongMessage {
  type: "pong";
}

interface SyncResponseMessage {
  type: "sync_response";
  payload: {
    conversations: Array<{
      id: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      messages: Array<{
        id: string;
        role: "user" | "assistant";
        content: string;
        toolUses: unknown[];
        attachments?: unknown[];
        timestamp: number;
      }>;
    }>;
    syncedAt: number;
  };
}

interface MessageSavedMessage {
  type: "message_saved";
  payload: { conversationId: string; messageId: string };
}

interface ConversationCreatedMessage {
  type: "conversation_created";
  payload: { id: string };
}

interface ConversationDeletedMessage {
  type: "conversation_deleted";
  payload: { id: string };
}

interface NotificationMessage {
  type: "notification";
  payload: {
    id: string;
    title: string;
    body: string;
    notifType: "summary" | "goal_followup" | "memory_followup" | "mood_check" | "nudge" | "reminder";
    priority: "low" | "medium" | "high" | "urgent";
    data?: Record<string, unknown>;
  };
}

type ServerMessage =
  | ConnectedMessage
  | TextDeltaMessage
  | ToolUseMessage
  | ToolResultMessage
  | ChatEndMessage
  | ErrorMessage
  | PongMessage
  | SyncResponseMessage
  | MessageSavedMessage
  | ConversationCreatedMessage
  | ConversationDeletedMessage
  | NotificationMessage;

// ============ Session Management ============

// Active sessions per user (shared with Telegram channel)
const userSessions = new Map<number, string>();

// Active chat promises (for cancellation)
const activeChatAborts = new Map<number, AbortController>();

// Connected WebSocket clients per user (for notifications)
const connectedClients = new Map<number, Set<ServerWebSocket<WebSocketData>>>();

// ============ Helper Functions ============

function send(ws: ServerWebSocket<WebSocketData>, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    console.error("[WS] Send error:", error);
  }
}

function extractTextContent(message: SDKMessage): string {
  if (message.type !== "assistant") return "";

  const content = message.message.content;
  if (typeof content === "string") return content;

  return (content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

// ============ Message Handlers ============

export function handleOpen(ws: ServerWebSocket<WebSocketData>): void {
  const { userId, sessionId } = ws.data;
  console.log(`[WS] Client connected: user ${userId}`);

  // Track connected client
  if (!connectedClients.has(userId)) {
    connectedClients.set(userId, new Set());
  }
  connectedClients.get(userId)!.add(ws);

  send(ws, {
    type: "connected",
    payload: { sessionId },
  });
}

export function handleClose(ws: ServerWebSocket<WebSocketData>): void {
  const { userId } = ws.data;
  console.log(`[WS] Client disconnected: user ${userId}`);

  // Remove from connected clients
  connectedClients.get(userId)?.delete(ws);
  if (connectedClients.get(userId)?.size === 0) {
    connectedClients.delete(userId);
  }

  // Cancel any active chat
  const abortController = activeChatAborts.get(userId);
  if (abortController) {
    abortController.abort();
    activeChatAborts.delete(userId);
  }
}

export async function handleMessage(
  ws: ServerWebSocket<WebSocketData>,
  rawMessage: string | Buffer
): Promise<void> {
  const { userId } = ws.data;

  try {
    const message: ClientMessage = JSON.parse(
      typeof rawMessage === "string" ? rawMessage : rawMessage.toString()
    );

    switch (message.type) {
      case "chat":
        await handleChat(ws, message.payload.message, message.payload.attachments);
        break;

      case "cancel":
        handleCancel(userId);
        break;

      case "ping":
        send(ws, { type: "pong" });
        break;

      case "sync_conversations":
        await handleSyncConversations(ws, message.payload.lastSyncAt);
        break;

      case "save_message":
        await handleSaveMessage(ws, message.payload);
        break;

      case "create_conversation":
        await handleCreateConversation(ws, message.payload);
        break;

      case "delete_conversation":
        await handleDeleteConversation(ws, message.payload);
        break;

      case "update_conversation_title":
        await handleUpdateConversationTitle(ws, message.payload);
        break;

      default:
        send(ws, { type: "error", payload: { error: "Unknown message type" } });
    }
  } catch (error) {
    console.error("[WS] Message parse error:", error);
    send(ws, { type: "error", payload: { error: "Invalid message format" } });
  }
}

function handleCancel(userId: number): void {
  const abortController = activeChatAborts.get(userId);
  if (abortController) {
    console.log(`[WS] Cancelling chat for user ${userId}`);
    abortController.abort();
    activeChatAborts.delete(userId);
  }
}

async function handleChat(ws: ServerWebSocket<WebSocketData>, message: string, attachments?: ChatAttachment[]): Promise<void> {
  const { userId } = ws.data;

  // Cancel any existing chat
  handleCancel(userId);

  // Create abort controller for this chat
  const abortController = new AbortController();
  activeChatAborts.set(userId, abortController);

  try {
    // If there are image attachments, build multimodal prompt
    let finalMessage = message;
    if (attachments?.length) {
      const imageAttachments = attachments.filter((a) => a.type === "image");
      if (imageAttachments.length > 0) {
        // Prepend image context info so the agent knows images were attached
        const imageNote = imageAttachments.length === 1
          ? "[Kullanıcı bir görsel ekledi. Görseli analiz et.]"
          : `[Kullanıcı ${imageAttachments.length} görsel ekledi. Görselleri analiz et.]`;
        finalMessage = `${imageNote}\n\n${message || "Bu görseli analiz et."}`;
      }

      const audioAttachments = attachments.filter((a) => a.type === "audio");
      if (audioAttachments.length > 0) {
        const audioNote = "[Kullanıcı sesli mesaj gönderdi. Mesaj transkribe edildi.]";
        finalMessage = `${audioNote}\n\n${message}`;
      }
    }

    await streamChat(ws, userId, finalMessage, abortController.signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log(`[WS] Chat aborted for user ${userId}`);
      return;
    }
    console.error("[WS] Chat error:", error);
    send(ws, {
      type: "error",
      payload: { error: error instanceof Error ? error.message : "Chat failed" },
    });
  } finally {
    activeChatAborts.delete(userId);
  }
}

async function streamChat(
  ws: ServerWebSocket<WebSocketData>,
  userId: number,
  message: string,
  signal: AbortSignal
): Promise<void> {
  // Ensure user exists
  await userManager.ensureUser(userId);
  const settings = await userManager.getUserSettings(userId);
  const userFolder = userManager.getUserFolder(userId);

  // Get persona and generate system prompt
  const personaService = await getPersonaService(userId);
  const persona = await personaService.getActivePersona();
  const systemPrompt = generatePersonaSystemPrompt(persona);

  // Get existing session
  const existingSessionId = userSessions.get(userId);

  // Track state
  const toolsUsed: string[] = [];
  let fullText = "";
  let sessionId = "";
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  console.log(`[WS] Chat started for user ${userId}: "${message.slice(0, 50)}..."`);

  const queryResult = query({
    prompt: message,
    options: {
      cwd: userFolder,
      systemPrompt,
      resume: existingSessionId,
      settingSources: ["project"],
      mcpServers: {
        memory: getMemoryServer(userId),
        gdrive: getGDriveServer(),
        goals: getGoalsServer(userId),
        persona: getPersonaServer(userId),
        telegram: getTelegramMcpServer(),
        // Helm - Browser control via Chrome extension
        helm: {
          type: "stdio" as const,
          command: "bun",
          args: ["run", "/home/fjds/.claude/mcp/helm/server/index.ts"],
        },
      },
      agents: {
        researcher: {
          description: "Web'de araştırma yapar, bilgi toplar.",
          prompt: "Sen bir araştırmacısın. Verilen konuyu araştır ve özetle. Türkçe yanıt ver.",
          tools: ["WebSearch", "WebFetch"],
        },
        summarizer: {
          description: "Uzun metinleri özetler.",
          prompt: "Sen bir özetleyicisin. Metni kısa ve öz özetle. Türkçe yanıt ver.",
        },
        "memory-expert": {
          description: "Hafızada arama yapar.",
          prompt: "Hafızada detaylı arama yap. Türkçe yanıt ver.",
          tools: ["mcp__memory__recall", "mcp__memory__memory_stats"],
        },
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                const input = hookInput as PreToolUseHookInput;
                const toolName = input.tool_name;
                const toolInput = input.tool_input as Record<string, unknown>;

                console.log(`[WS] Tool: ${toolName}`);
                toolsUsed.push(toolName);

                // Send tool_use event to client
                send(ws, {
                  type: "tool_use",
                  payload: { tool: { name: toolName, input: toolInput } },
                });

                // Permission check (web always uses smart mode for now)
                const mode = (settings.permissionMode || config.PERMISSION_MODE) as PermissionMode;

                if (needsPermission(mode, toolName, toolInput)) {
                  // For web, we auto-deny dangerous operations for now
                  // TODO: Implement permission UI in frontend
                  console.log(`[WS] Auto-denying dangerous tool: ${toolName}`);
                  send(ws, {
                    type: "tool_result",
                    payload: {
                      toolResult: {
                        name: toolName,
                        status: "error",
                        output: "Permission denied (web mode)",
                      },
                    },
                  });
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "deny" as const,
                      permissionDecisionReason: "Web mode - dangerous operation denied",
                    },
                  };
                }

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
      maxTurns: 10,
    },
  });

  // Process streaming messages
  for await (const msg of queryResult) {
    // Check if aborted
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          userSessions.set(userId, sessionId);
          ws.data.sessionId = sessionId;
          console.log(`[WS] Session: ${sessionId.slice(0, 8)}...`);
        }
        break;

      case "assistant":
        const newText = extractTextContent(msg);
        if (newText && newText !== fullText) {
          const delta = newText.slice(fullText.length);
          fullText = newText;

          if (delta) {
            send(ws, {
              type: "text_delta",
              payload: { delta, fullText },
            });
          }
        }
        break;

      case "result":
        const result = msg as SDKResultMessage;
        if (result.subtype === "success") {
          totalCost = result.total_cost_usd;
          inputTokens = result.usage.input_tokens;
          outputTokens = result.usage.output_tokens;

          // Final result
          if (result.result && result.result !== fullText) {
            const delta = result.result.slice(fullText.length);
            if (delta) {
              send(ws, {
                type: "text_delta",
                payload: { delta, fullText: result.result },
              });
            }
          }
        } else {
          console.error(`[WS] Error: ${result.subtype}`, (result as any).errors);
          send(ws, {
            type: "error",
            payload: { error: `Chat error: ${result.subtype}` },
          });
        }
        break;
    }
  }

  // Send chat_end
  send(ws, {
    type: "chat_end",
    payload: {
      usage: {
        inputTokens,
        outputTokens,
        costUsd: totalCost,
      },
      toolsUsed: [...new Set(toolsUsed)],
    },
  });

  console.log(`[WS] Chat completed: ${toolsUsed.length} tools, $${totalCost.toFixed(4)}`);
}

// ============ Conversation Sync Handlers ============

async function handleSyncConversations(
  ws: ServerWebSocket<WebSocketData>,
  lastSyncAt: number | null
): Promise<void> {
  const { userId } = ws.data;

  try {
    const memory = userManager.getUserMemory(userId);
    const conversations = lastSyncAt !== null
      ? memory.getConversationsSince(lastSyncAt)
      : memory.getAllConversations();

    send(ws, {
      type: "sync_response",
      payload: {
        conversations,
        syncedAt: Date.now(),
      },
    });

    console.log(`[WS] Synced ${conversations.length} conversations for user ${userId}`);
  } catch (error) {
    console.error("[WS] Sync error:", error);
    send(ws, {
      type: "error",
      payload: { error: "Failed to sync conversations" },
    });
  }
}

async function handleSaveMessage(
  ws: ServerWebSocket<WebSocketData>,
  payload: SaveMessageMessage["payload"]
): Promise<void> {
  const { userId } = ws.data;
  const { conversationId, message } = payload;

  try {
    const memory = userManager.getUserMemory(userId);
    memory.saveConversationMessage(conversationId, message);

    // Auto-title if first user message
    if (message.role === "user") {
      memory.autoTitleConversation(conversationId, message.content);
    }

    send(ws, {
      type: "message_saved",
      payload: { conversationId, messageId: message.id },
    });
  } catch (error) {
    console.error("[WS] Save message error:", error);
    send(ws, {
      type: "error",
      payload: { error: "Failed to save message" },
    });
  }
}

async function handleCreateConversation(
  ws: ServerWebSocket<WebSocketData>,
  payload: CreateConversationMessage["payload"]
): Promise<void> {
  const { userId } = ws.data;
  const { id, title, createdAt } = payload;

  try {
    const memory = userManager.getUserMemory(userId);
    memory.createConversation(id, title, createdAt);

    send(ws, {
      type: "conversation_created",
      payload: { id },
    });

    console.log(`[WS] Created conversation ${id} for user ${userId}`);
  } catch (error) {
    console.error("[WS] Create conversation error:", error);
    send(ws, {
      type: "error",
      payload: { error: "Failed to create conversation" },
    });
  }
}

async function handleDeleteConversation(
  ws: ServerWebSocket<WebSocketData>,
  payload: DeleteConversationMessage["payload"]
): Promise<void> {
  const { userId } = ws.data;
  const { id } = payload;

  try {
    const memory = userManager.getUserMemory(userId);
    memory.deleteConversation(id);

    send(ws, {
      type: "conversation_deleted",
      payload: { id },
    });

    console.log(`[WS] Deleted conversation ${id} for user ${userId}`);
  } catch (error) {
    console.error("[WS] Delete conversation error:", error);
    send(ws, {
      type: "error",
      payload: { error: "Failed to delete conversation" },
    });
  }
}

async function handleUpdateConversationTitle(
  ws: ServerWebSocket<WebSocketData>,
  payload: UpdateConversationTitleMessage["payload"]
): Promise<void> {
  const { userId } = ws.data;
  const { id, title } = payload;

  try {
    const memory = userManager.getUserMemory(userId);
    memory.updateConversationTitle(id, title);

    console.log(`[WS] Updated conversation title ${id} for user ${userId}`);
  } catch (error) {
    console.error("[WS] Update title error:", error);
    send(ws, {
      type: "error",
      payload: { error: "Failed to update conversation title" },
    });
  }
}

// ============ Session Sharing ============

/**
 * Get shared session for a user (used by both Telegram and Web)
 */
export function getSharedSession(userId: number): string | null {
  return userSessions.get(userId) || null;
}

/**
 * Set shared session
 */
export function setSharedSession(userId: number, sessionId: string): void {
  userSessions.set(userId, sessionId);
}

/**
 * Clear shared session
 */
export function clearSharedSession(userId: number): void {
  userSessions.delete(userId);
}

/**
 * Send a notification to all connected clients of a user
 */
export function sendNotificationToClients(
  userId: number,
  notification: {
    id: string;
    title: string;
    body: string;
    notifType: "summary" | "goal_followup" | "memory_followup" | "mood_check" | "nudge" | "reminder";
    priority: "low" | "medium" | "high" | "urgent";
    data?: Record<string, unknown>;
  }
): boolean {
  const clients = connectedClients.get(userId);
  if (!clients || clients.size === 0) return false;

  for (const ws of clients) {
    send(ws, {
      type: "notification",
      payload: notification,
    });
  }

  console.log(`[WS] Notification sent to ${clients.size} client(s) of user ${userId}: ${notification.title}`);
  return true;
}

/**
 * Check if a user has any connected clients
 */
export function hasConnectedClients(userId: number): boolean {
  return (connectedClients.get(userId)?.size ?? 0) > 0;
}

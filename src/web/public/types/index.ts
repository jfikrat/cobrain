// ============ Type Definitions ============

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolUses?: ToolUse[];
  timestamp: number;
}

export interface ToolUse {
  name: string;
  input: unknown;
  status: "running" | "success" | "error";
  output?: string;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type Theme = "dark" | "light";

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface WebSocketMessage {
  type: string;
  payload?: unknown;
}

export interface TextDeltaPayload {
  delta: string;
  fullText: string;
}

export interface ToolUsePayload {
  tool: {
    name: string;
    input: unknown;
  };
}

export interface ToolResultPayload {
  toolResult: {
    name: string;
    status: "success" | "error";
    output?: string;
  };
}

export interface ChatEndPayload {
  usage: UsageStats;
  toolsUsed: string[];
}

export interface ErrorPayload {
  error: string;
}

// Keyboard shortcut types
export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  handler: () => void;
  description: string;
}

// Search result types
export interface SearchResult {
  messageId: string;
  conversationId: string;
  content: string;
  role: "user" | "assistant";
  timestamp: number;
  matchIndices: [number, number][];
}

// Export types
export type ExportFormat = "markdown" | "json";

export interface ExportOptions {
  format: ExportFormat;
  includeTimestamps?: boolean;
  includeToolUsage?: boolean;
}

// ============ Server Sync Types ============

// Client -> Server sync messages
export interface SyncConversationsPayload {
  lastSyncAt: number | null;
}

export interface SaveMessagePayload {
  conversationId: string;
  message: {
    id: string;
    role: "user" | "assistant";
    content: string;
    toolUses?: ToolUse[];
    timestamp: number;
  };
}

export interface CreateConversationPayload {
  id: string;
  title: string;
  createdAt: number;
}

export interface DeleteConversationPayload {
  id: string;
}

export interface UpdateConversationTitlePayload {
  id: string;
  title: string;
}

// Server -> Client sync messages
export interface SyncResponsePayload {
  conversations: ServerConversation[];
  syncedAt: number;
}

export interface MessageSavedPayload {
  conversationId: string;
  messageId: string;
}

export interface ConversationCreatedPayload {
  id: string;
}

export interface ConversationDeletedPayload {
  id: string;
}

// Server conversation format (slightly different from client)
export interface ServerConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ServerMessage[];
}

export interface ServerMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolUses: unknown[];
  timestamp: number;
}

// Sync state
export type SyncStatus = "idle" | "syncing" | "synced" | "error";

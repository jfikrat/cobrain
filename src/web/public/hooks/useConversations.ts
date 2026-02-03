import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useLocalStorage, STORAGE_KEYS } from "./useLocalStorage";
import type {
  Conversation,
  Message,
  SyncStatus,
  ServerConversation,
  SyncResponsePayload,
  MessageSavedPayload,
  ToolUse,
} from "../types";
import { generateId } from "../utils/helpers";

interface UseConversationsOptions {
  send: (type: string, payload?: unknown) => void;
  onMessage: (type: string, handler: (data: unknown) => void) => () => void;
  isConnected: boolean;
  isTyping?: boolean; // When true, skip sync to avoid conflicts during streaming
}

interface UseConversationsReturn {
  conversations: Conversation[];
  activeConversation: Conversation | null;
  activeConversationId: string | null;
  createConversation: (title?: string) => Conversation;
  deleteConversation: (id: string) => void;
  switchConversation: (id: string) => void;
  updateConversationTitle: (id: string, title: string) => void;
  addMessage: (message: Message) => void;
  updateLastMessage: (content: string, toolUses?: Message["toolUses"]) => void;
  saveLastMessage: () => void;
  clearConversations: () => void;
  syncStatus: SyncStatus;
  lastSyncAt: number | null;
  groupedConversations: {
    today: Conversation[];
    yesterday: Conversation[];
    thisWeek: Conversation[];
    older: Conversation[];
  };
}

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 100;

/**
 * Convert server message to client message format
 */
function serverMessageToClient(msg: ServerConversation["messages"][0]): Message {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    toolUses: (msg.toolUses || []).map((tu: unknown) => {
      const toolUse = tu as Record<string, unknown>;
      return {
        name: String(toolUse.name || ""),
        input: toolUse.input,
        status: (toolUse.status as ToolUse["status"]) || "success",
        output: toolUse.output as string | undefined,
      };
    }),
    timestamp: msg.timestamp,
  };
}

/**
 * Convert server conversation to client format
 */
function serverConversationToClient(conv: ServerConversation): Conversation {
  return {
    id: conv.id,
    title: conv.title,
    messages: conv.messages.map(serverMessageToClient),
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

/**
 * Merge server conversations with local conversations
 * Server wins on conflicts (by updatedAt timestamp)
 */
function mergeConversations(
  local: Conversation[],
  server: ServerConversation[]
): Conversation[] {
  const merged = new Map<string, Conversation>();

  // Add local conversations
  for (const conv of local) {
    merged.set(conv.id, conv);
  }

  // Merge server conversations (server wins if newer)
  for (const serverConv of server) {
    const existing = merged.get(serverConv.id);
    if (!existing || serverConv.updatedAt > existing.updatedAt) {
      merged.set(serverConv.id, serverConversationToClient(serverConv));
    }
  }

  // Sort by updatedAt desc and limit
  return Array.from(merged.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

/**
 * Hook for managing multiple conversations with server sync
 */
export function useConversations(options?: UseConversationsOptions): UseConversationsReturn {
  const { send, onMessage, isConnected, isTyping = false } = options || {
    send: () => {},
    onMessage: () => () => {},
    isConnected: false,
    isTyping: false,
  };

  const [conversations, setConversations] = useLocalStorage<Conversation[]>(
    STORAGE_KEYS.CONVERSATIONS,
    []
  );
  const [activeConversationId, setActiveConversationId] = useLocalStorage<string | null>(
    STORAGE_KEYS.ACTIVE_CONVERSATION,
    null
  );
  const [lastSyncAt, setLastSyncAt] = useLocalStorage<number | null>(
    "cobrain_last_sync",
    null
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");

  // Track pending saves to avoid duplicates
  const pendingSaves = useRef<Set<string>>(new Set());

  // Only sync once per session (page load), not on reconnects
  const hasSyncedRef = useRef(false);

  // Get active conversation
  const activeConversation = useMemo(() => {
    if (!activeConversationId) return null;
    return conversations.find((c) => c.id === activeConversationId) || null;
  }, [conversations, activeConversationId]);

  // ========== Server Sync ==========

  // Track isTyping in a ref to avoid stale closure in message handler
  const isTypingRef = useRef(isTyping);
  isTypingRef.current = isTyping;

  // Handle sync response from server (only happens once on page load)
  useEffect(() => {
    const unsubscribe = onMessage("sync_response", (data: unknown) => {
      // Skip sync during streaming to avoid conflicts
      if (isTypingRef.current) {
        console.log("[Sync] Skipping sync response during streaming");
        return;
      }

      const payload = data as SyncResponsePayload;
      console.log(`[Sync] Received ${payload.conversations.length} conversations from server`);

      // On initial sync: if server has data, use it (replace local)
      // This ensures clean state on page load
      if (payload.conversations.length > 0) {
        const serverConvs = payload.conversations.map(serverConversationToClient);
        setConversations(serverConvs);
      }
      // If server is empty but local has data, keep local (will be synced on save)

      setLastSyncAt(payload.syncedAt);
      setSyncStatus("synced");
    });

    return unsubscribe;
  }, [onMessage, setConversations, setLastSyncAt]);

  // Handle message saved confirmation
  useEffect(() => {
    const unsubscribe = onMessage("message_saved", (data: unknown) => {
      const payload = data as MessageSavedPayload;
      pendingSaves.current.delete(`${payload.conversationId}:${payload.messageId}`);
    });

    return unsubscribe;
  }, [onMessage]);

  // Sync only ONCE per session (on first connect), not on reconnects
  useEffect(() => {
    if (isConnected && !hasSyncedRef.current) {
      console.log("[Sync] First connect, requesting initial sync...");
      hasSyncedRef.current = true;
      setSyncStatus("syncing");
      send("sync_conversations", { lastSyncAt: null }); // Always full sync on page load
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, send]);

  // ========== Helper to save message to server ==========

  const saveMessageToServer = useCallback(
    (conversationId: string, message: Message, force = false) => {
      if (!isConnected) return;

      // Don't save empty assistant messages (they'll be saved when content arrives)
      if (!force && message.role === "assistant" && !message.content.trim()) {
        return;
      }

      const key = `${conversationId}:${message.id}`;
      if (pendingSaves.current.has(key)) return;

      pendingSaves.current.add(key);
      send("save_message", {
        conversationId,
        message: {
          id: message.id,
          role: message.role,
          content: message.content,
          toolUses: message.toolUses || [],
          timestamp: message.timestamp,
        },
      });
    },
    [isConnected, send]
  );

  // ========== Conversation Operations ==========

  // Create new conversation
  const createConversation = useCallback(
    (title?: string): Conversation => {
      const newConversation: Conversation = {
        id: generateId(),
        title: title || "Yeni Sohbet",
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setConversations((prev) => {
        const updated = [newConversation, ...prev];
        return updated.slice(0, MAX_CONVERSATIONS);
      });

      setActiveConversationId(newConversation.id);

      // Sync to server
      if (isConnected) {
        send("create_conversation", {
          id: newConversation.id,
          title: newConversation.title,
          createdAt: newConversation.createdAt,
        });
      }

      return newConversation;
    },
    [setConversations, setActiveConversationId, isConnected, send]
  );

  // Delete conversation
  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));

      // If deleted active conversation, switch to another
      if (activeConversationId === id) {
        setActiveConversationId((prev) => {
          const remaining = conversations.filter((c) => c.id !== id);
          return remaining.length > 0 ? remaining[0]!.id : null;
        });
      }

      // Sync to server
      if (isConnected) {
        send("delete_conversation", { id });
      }
    },
    [conversations, activeConversationId, setConversations, setActiveConversationId, isConnected, send]
  );

  // Switch conversation
  const switchConversation = useCallback(
    (id: string) => {
      const exists = conversations.some((c) => c.id === id);
      if (exists) {
        setActiveConversationId(id);
      }
    },
    [conversations, setActiveConversationId]
  );

  // Update conversation title
  const updateConversationTitle = useCallback(
    (id: string, title: string) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, title, updatedAt: Date.now() } : c
        )
      );

      // Sync to server
      if (isConnected) {
        send("update_conversation_title", { id, title });
      }
    },
    [setConversations, isConnected, send]
  );

  // Add message to active conversation
  const addMessage = useCallback(
    (message: Message) => {
      if (!activeConversationId) {
        // Create new conversation if none active
        const newConv = createConversation();
        setConversations((prev) =>
          prev.map((c) =>
            c.id === newConv.id
              ? {
                  ...c,
                  messages: [message],
                  updatedAt: Date.now(),
                  title:
                    message.role === "user"
                      ? message.content.slice(0, 50) + (message.content.length > 50 ? "..." : "")
                      : c.title,
                }
              : c
          )
        );

        // Save message to server
        saveMessageToServer(newConv.id, message);
        return;
      }

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== activeConversationId) return c;

          const messages = [...c.messages, message].slice(-MAX_MESSAGES_PER_CONVERSATION);

          return {
            ...c,
            messages,
            updatedAt: Date.now(),
            title:
              c.title === "Yeni Sohbet" && message.role === "user"
                ? message.content.slice(0, 50) + (message.content.length > 50 ? "..." : "")
                : c.title,
          };
        })
      );

      // Save message to server
      saveMessageToServer(activeConversationId, message);
    },
    [activeConversationId, createConversation, setConversations, saveMessageToServer]
  );

  // Update last message (for streaming) - does NOT save to server (save happens on chat_end)
  const updateLastMessage = useCallback(
    (content: string, toolUses?: Message["toolUses"]) => {
      if (!activeConversationId) return;

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== activeConversationId) return c;
          if (c.messages.length === 0) return c;

          const messages = [...c.messages];
          const lastMsg = messages[messages.length - 1];
          if (lastMsg) {
            messages[messages.length - 1] = {
              ...lastMsg,
              content,
              toolUses: toolUses || lastMsg.toolUses,
            };
          }

          return { ...c, messages, updatedAt: Date.now() };
        })
      );
      // Note: Don't save during streaming - save happens on chat_end via saveLastMessage
    },
    [activeConversationId, setConversations]
  );

  // Save the last message to server (called on chat_end)
  const saveLastMessage = useCallback(() => {
    if (!activeConversationId) return;

    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv || conv.messages.length === 0) return;

    const lastMsg = conv.messages[conv.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant" && lastMsg.content.trim()) {
      saveMessageToServer(activeConversationId, lastMsg, true);
    }
  }, [activeConversationId, conversations, saveMessageToServer]);

  // Clear all conversations
  const clearConversations = useCallback(() => {
    // Delete all from server
    if (isConnected) {
      for (const conv of conversations) {
        send("delete_conversation", { id: conv.id });
      }
    }

    setConversations([]);
    setActiveConversationId(null);
    setLastSyncAt(null);
  }, [conversations, setConversations, setActiveConversationId, setLastSyncAt, isConnected, send]);

  // Group conversations by date
  const groupedConversations = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStart = yesterday.getTime();

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStart = weekAgo.getTime();

    const groups = {
      today: [] as Conversation[],
      yesterday: [] as Conversation[],
      thisWeek: [] as Conversation[],
      older: [] as Conversation[],
    };

    // Sort by updatedAt desc
    const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

    for (const conv of sorted) {
      if (conv.updatedAt >= todayStart) {
        groups.today.push(conv);
      } else if (conv.updatedAt >= yesterdayStart) {
        groups.yesterday.push(conv);
      } else if (conv.updatedAt >= weekStart) {
        groups.thisWeek.push(conv);
      } else {
        groups.older.push(conv);
      }
    }

    return groups;
  }, [conversations]);

  return {
    conversations,
    activeConversation,
    activeConversationId,
    createConversation,
    deleteConversation,
    switchConversation,
    updateConversationTitle,
    addMessage,
    updateLastMessage,
    saveLastMessage,
    clearConversations,
    syncStatus,
    lastSyncAt,
    groupedConversations,
  };
}

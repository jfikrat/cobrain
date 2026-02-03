import React, { useState, useCallback, useEffect, useRef } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { InputArea } from "./InputArea";
import { useTheme } from "../../hooks/useTheme";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useConversations } from "../../hooks/useConversations";
import { useKeyboardShortcut, SHORTCUTS } from "../../hooks/useKeyboardShortcuts";
import { useLocalStorage, STORAGE_KEYS } from "../../hooks/useLocalStorage";
import { generateId } from "../../utils/helpers";
import type {
  Message,
  UsageStats,
  TextDeltaPayload,
  ToolUsePayload,
  ToolResultPayload,
  ChatEndPayload,
  ToolUse,
} from "../../types";

interface ChatLayoutProps {
  token: string;
  onOpenSearch: () => void;
  onOpenExport: () => void;
}

export function ChatLayout({ token, onOpenSearch, onOpenExport }: ChatLayoutProps) {
  const [theme, toggleTheme] = useTheme();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage(STORAGE_KEYS.SIDEBAR_COLLAPSED, true);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);

  const currentMessageRef = useRef<Message | null>(null);

  const { status, error, send, onMessage } = useWebSocket(token);

  const {
    conversations,
    activeConversation,
    activeConversationId,
    createConversation,
    deleteConversation,
    switchConversation,
    addMessage,
    updateLastMessage,
    saveLastMessage,
    clearConversations,
    syncStatus,
    groupedConversations,
  } = useConversations({
    send,
    onMessage,
    isConnected: status === "connected",
    isTyping,
  });

  // Keyboard shortcuts
  useKeyboardShortcut(SHORTCUTS.SEARCH, onOpenSearch);
  useKeyboardShortcut(SHORTCUTS.NEW_CONVERSATION, () => createConversation());
  useKeyboardShortcut(SHORTCUTS.EXPORT, onOpenExport);
  useKeyboardShortcut(SHORTCUTS.TOGGLE_SIDEBAR, () => setSidebarOpen((prev) => !prev));

  // WebSocket message handlers
  useEffect(() => {
    const unsubText = onMessage("text_delta", (data: unknown) => {
      const { fullText } = data as TextDeltaPayload;

      // If no current message, create one (first text_delta)
      if (!currentMessageRef.current) {
        const assistantMessage: Message = {
          id: generateId(),
          role: "assistant",
          content: fullText,
          toolUses: [],
          timestamp: Date.now(),
        };
        currentMessageRef.current = assistantMessage;
        addMessage(assistantMessage);
      } else {
        currentMessageRef.current.content = fullText;
        updateLastMessage(fullText);
      }
    });

    const unsubTool = onMessage("tool_use", (data: unknown) => {
      const { tool } = data as ToolUsePayload;
      if (currentMessageRef.current) {
        const toolUse: ToolUse = {
          name: tool.name,
          input: tool.input,
          status: "running",
        };
        currentMessageRef.current.toolUses = [
          ...(currentMessageRef.current.toolUses || []),
          toolUse,
        ];
        updateLastMessage(
          currentMessageRef.current.content,
          currentMessageRef.current.toolUses
        );
      }
    });

    const unsubToolResult = onMessage("tool_result", (data: unknown) => {
      const { toolResult } = data as ToolResultPayload;
      if (currentMessageRef.current?.toolUses) {
        const tools = currentMessageRef.current.toolUses;
        const lastTool = tools.find(
          (t) => t.name === toolResult.name && t.status === "running"
        );
        if (lastTool) {
          lastTool.status = toolResult.status;
          lastTool.output = toolResult.output;
          updateLastMessage(
            currentMessageRef.current.content,
            currentMessageRef.current.toolUses
          );
        }
      }
    });

    const unsubEnd = onMessage("chat_end", (data: unknown) => {
      const { usage } = data as ChatEndPayload;
      setIsTyping(false);
      setUsage(usage);
      currentMessageRef.current = null;
      // Save the completed assistant message to server
      saveLastMessage();
    });

    const unsubError = onMessage("error", () => {
      setIsTyping(false);
      currentMessageRef.current = null;
    });

    return () => {
      unsubText();
      unsubTool();
      unsubToolResult();
      unsubEnd();
      unsubError();
    };
  }, [onMessage, addMessage, updateLastMessage, saveLastMessage]);

  // Handle send message
  const handleSend = useCallback(() => {
    if (!input.trim() || status !== "connected" || isTyping) return;

    const userMessage: Message = {
      id: generateId(),
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };

    // Only add user message - assistant message will be created on first text_delta
    addMessage(userMessage);
    currentMessageRef.current = null; // Will be created when streaming starts

    setInput("");
    setIsTyping(true);
    setUsage(null);

    send("chat", { message: userMessage.content });
  }, [input, status, isTyping, addMessage, send]);

  // Handle stop generation
  const handleStop = useCallback(() => {
    // TODO: Implement stop generation via WebSocket
    setIsTyping(false);
    currentMessageRef.current = null;
  }, []);

  // Handle clear history
  const handleClearHistory = useCallback(() => {
    if (confirm("Tüm sohbet geçmişi silinsin mi?")) {
      clearConversations();
    }
  }, [clearConversations]);

  // Handle new conversation
  const handleNewConversation = useCallback(() => {
    createConversation();
    setInput("");
  }, [createConversation]);

  // Get current messages
  const messages = activeConversation?.messages || [];

  return (
    <div className="app">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        conversations={groupedConversations}
        activeConversationId={activeConversationId}
        onNewConversation={handleNewConversation}
        onSelectConversation={switchConversation}
        onDeleteConversation={deleteConversation}
        onOpenSearch={onOpenSearch}
        onOpenExport={onOpenExport}
      />

      <div className="app-main">
        <Header
          status={status}
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          onClearHistory={handleClearHistory}
        />

        {error && <div className="error-banner">{error}</div>}

        <div className="chat-container">
          <MessageList messages={messages} isTyping={isTyping} />

          <InputArea
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            status={status}
            isTyping={isTyping}
          />

          {usage && (
            <div className="usage-stats" style={{ padding: "0 var(--space-lg) var(--space-md)" }}>
              <span className="usage-stat">
                {usage.inputTokens.toLocaleString()} / {usage.outputTokens.toLocaleString()} token
              </span>
              <span className="usage-stat">${usage.costUsd.toFixed(4)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import React, { useRef, useEffect } from "react";
import { MessageItem } from "./MessageItem";
import { TypingIndicator } from "./TypingIndicator";
import { EmptyState } from "./EmptyState";
import type { Message } from "../../types";

interface MessageListProps {
  messages: Message[];
  isTyping: boolean;
  showTypingIndicator?: boolean;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
}

export function MessageList({
  messages,
  isTyping,
  showTypingIndicator = true,
  onRegenerate,
  onEdit,
}: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  if (messages.length === 0 && !isTyping) {
    return (
      <div className="messages">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="messages">
      {messages.map((msg) => (
        <MessageItem
          key={msg.id}
          message={msg}
          onRegenerate={onRegenerate ? () => onRegenerate(msg.id) : undefined}
          onEdit={onEdit ? () => onEdit(msg.id) : undefined}
        />
      ))}

      {showTypingIndicator &&
        isTyping &&
        messages.length > 0 &&
        messages[messages.length - 1]?.content === "" && <TypingIndicator />}

      <div ref={messagesEndRef} />
    </div>
  );
}

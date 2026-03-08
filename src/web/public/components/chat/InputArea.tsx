import React, { useRef, useCallback, useEffect } from "react";
import { IconButton } from "../ui/IconButton";
import { SendIcon, StopIcon, PaperclipIcon, MicIcon } from "../ui/Icons";
import type { ConnectionStatus } from "../../types";

interface InputAreaProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  status: ConnectionStatus;
  isTyping: boolean;
  placeholder?: string;
  showFileUpload?: boolean;
  showVoiceInput?: boolean;
  onFileUpload?: () => void;
  onVoiceInput?: () => void;
}

export function InputArea({
  value,
  onChange,
  onSend,
  onStop,
  status,
  isTyping,
  placeholder = "Type your message...",
  showFileUpload = false,
  showVoiceInput = false,
  onFileUpload,
  onVoiceInput,
}: InputAreaProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);

      // Reset height to auto to get the correct scrollHeight
      const target = e.target;
      target.style.height = "auto";
      target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
    },
    [onChange]
  );

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Send on Enter (without Shift)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (value.trim() && status === "connected" && !isTyping) {
          onSend();
          // Reset textarea height after sending
          if (inputRef.current) {
            inputRef.current.style.height = "auto";
          }
        }
      }
    },
    [value, status, isTyping, onSend]
  );

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset height when value is cleared
  useEffect(() => {
    if (!value && inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  }, [value]);

  const canSend = value.trim() && status === "connected" && !isTyping;
  const isDisabled = status !== "connected";

  return (
    <div className="input-area">
      <div className="input-container">
        <div className="input-wrapper">
          {(showFileUpload || showVoiceInput) && (
            <div className="input-actions">
              {showFileUpload && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  onClick={onFileUpload}
                  disabled={isDisabled}
                  tooltip="Attach file"
                >
                  <PaperclipIcon size={18} />
                </IconButton>
              )}
              {showVoiceInput && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  onClick={onVoiceInput}
                  disabled={isDisabled}
                  tooltip="Voice input"
                >
                  <MicIcon size={18} />
                </IconButton>
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="message-input"
            placeholder={placeholder}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            rows={1}
            aria-label="Enter message"
          />
        </div>

        {isTyping && onStop ? (
          <button
            className="send-button"
            onClick={onStop}
            aria-label="Stop"
            style={{ background: "var(--error)" }}
          >
            <StopIcon size={20} />
          </button>
        ) : (
          <button
            className="send-button"
            onClick={onSend}
            disabled={!canSend}
            aria-label="Send"
          >
            <SendIcon size={20} />
          </button>
        )}
      </div>

      <div className="input-hint" style={{
        fontSize: "var(--text-xs)",
        color: "var(--text-muted)",
        marginTop: "var(--space-xs)",
        textAlign: "center"
      }}>
        <kbd style={{
          padding: "2px 6px",
          background: "var(--bg-tertiary)",
          borderRadius: "var(--radius-xs)",
          fontSize: "0.7rem"
        }}>Enter</kbd> send, <kbd style={{
          padding: "2px 6px",
          background: "var(--bg-tertiary)",
          borderRadius: "var(--radius-xs)",
          fontSize: "0.7rem"
        }}>Shift+Enter</kbd> new line
      </div>
    </div>
  );
}

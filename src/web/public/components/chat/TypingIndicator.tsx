import React from "react";

export function TypingIndicator() {
  return (
    <div className="message assistant">
      <div className="message-avatar">C</div>
      <div className="message-content">
        <div className="message-role">Cobrain</div>
        <div className="typing-indicator">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  );
}

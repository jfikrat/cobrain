import React, { useState } from "react";
import { IconButton } from "../ui/IconButton";
import { CopyIcon, CheckIcon, RefreshIcon, EditIcon } from "../ui/Icons";
import { copyToClipboard } from "../../utils/helpers";
import type { Message } from "../../types";

interface MessageActionsProps {
  message: Message;
  onRegenerate?: () => void;
  onEdit?: () => void;
  showRegenerate?: boolean;
  showEdit?: boolean;
}

export function MessageActions({
  message,
  onRegenerate,
  onEdit,
  showRegenerate = false,
  showEdit = false,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(message.content);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="message-actions">
      <IconButton
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        tooltip={copied ? "Kopyalandı!" : "Kopyala"}
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </IconButton>

      {showEdit && message.role === "user" && (
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onEdit}
          tooltip="Düzenle"
        >
          <EditIcon size={14} />
        </IconButton>
      )}

      {showRegenerate && message.role === "assistant" && (
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onRegenerate}
          tooltip="Yeniden oluştur"
        >
          <RefreshIcon size={14} />
        </IconButton>
      )}
    </div>
  );
}

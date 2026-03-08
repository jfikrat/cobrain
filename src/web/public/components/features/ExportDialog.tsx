import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { DownloadIcon, CheckIcon } from "../ui/Icons";
import { downloadConversation, downloadAllConversations } from "../../utils/export";
import type { Conversation, ExportFormat } from "../../types";

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  activeConversation: Conversation | null;
}

export function ExportDialog({
  isOpen,
  onClose,
  conversations,
  activeConversation,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [exportType, setExportType] = useState<"current" | "all">(
    activeConversation ? "current" : "all"
  );
  const [exported, setExported] = useState(false);

  const handleExport = () => {
    if (exportType === "current" && activeConversation) {
      downloadConversation(activeConversation, format);
    } else {
      downloadAllConversations(conversations, format);
    }

    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  const hasConversations = conversations.length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Export Conversations"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={!hasConversations || exported}>
            {exported ? (
              <>
                <CheckIcon size={16} /> Downloaded
              </>
            ) : (
              <>
                <DownloadIcon size={16} /> Export
              </>
            )}
          </Button>
        </>
      }
    >
      {!hasConversations ? (
        <div
          style={{
            padding: "var(--space-xl)",
            textAlign: "center",
            color: "var(--text-muted)",
          }}
        >
          <DownloadIcon size={48} />
          <p style={{ marginTop: "var(--space-md)" }}>No conversations to export</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-lg)" }}>
          {/* Export type selection */}
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "var(--space-sm)",
                fontWeight: 500,
              }}
            >
              Export
            </label>
            <div style={{ display: "flex", gap: "var(--space-sm)" }}>
              {activeConversation && (
                <button
                  onClick={() => setExportType("current")}
                  style={{
                    flex: 1,
                    padding: "var(--space-md)",
                    background:
                      exportType === "current" ? "var(--accent-muted)" : "var(--bg-tertiary)",
                    border: `1px solid ${
                      exportType === "current" ? "var(--accent-primary)" : "var(--border-color)"
                    }`,
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "var(--text-primary)",
                  }}
                >
                  <div style={{ fontWeight: 500 }}>Active Conversation</div>
                  <div
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--text-secondary)",
                      marginTop: "var(--space-xs)",
                    }}
                  >
                    {activeConversation.title}
                  </div>
                </button>
              )}
              <button
                onClick={() => setExportType("all")}
                style={{
                  flex: 1,
                  padding: "var(--space-md)",
                  background: exportType === "all" ? "var(--accent-muted)" : "var(--bg-tertiary)",
                  border: `1px solid ${
                    exportType === "all" ? "var(--accent-primary)" : "var(--border-color)"
                  }`,
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "var(--text-primary)",
                }}
              >
                <div style={{ fontWeight: 500 }}>All Conversations</div>
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                    marginTop: "var(--space-xs)",
                  }}
                >
                  {conversations.length} conversation(s)
                </div>
              </button>
            </div>
          </div>

          {/* Format selection */}
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "var(--space-sm)",
                fontWeight: 500,
              }}
            >
              Format
            </label>
            <div style={{ display: "flex", gap: "var(--space-sm)" }}>
              <button
                onClick={() => setFormat("markdown")}
                style={{
                  flex: 1,
                  padding: "var(--space-md)",
                  background:
                    format === "markdown" ? "var(--accent-muted)" : "var(--bg-tertiary)",
                  border: `1px solid ${
                    format === "markdown" ? "var(--accent-primary)" : "var(--border-color)"
                  }`,
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "var(--text-primary)",
                }}
              >
                <div style={{ fontWeight: 500 }}>Markdown</div>
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                    marginTop: "var(--space-xs)",
                  }}
                >
                  Readable format (.md)
                </div>
              </button>
              <button
                onClick={() => setFormat("json")}
                style={{
                  flex: 1,
                  padding: "var(--space-md)",
                  background: format === "json" ? "var(--accent-muted)" : "var(--bg-tertiary)",
                  border: `1px solid ${
                    format === "json" ? "var(--accent-primary)" : "var(--border-color)"
                  }`,
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  textAlign: "left",
                  color: "var(--text-primary)",
                }}
              >
                <div style={{ fontWeight: 500 }}>JSON</div>
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--text-secondary)",
                    marginTop: "var(--space-xs)",
                  }}
                >
                  Structured data (.json)
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

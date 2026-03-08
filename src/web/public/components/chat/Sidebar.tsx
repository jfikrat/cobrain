import React from "react";
import { IconButton } from "../ui/IconButton";
import {
  PlusIcon,
  SearchIcon,
  MessageIcon,
  TrashIcon,
  ChevronLeftIcon,
  SettingsIcon,
  DownloadIcon,
} from "../ui/Icons";
import { formatRelativeDate, cn } from "../../utils/helpers";
import type { Conversation } from "../../types";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: {
    today: Conversation[];
    yesterday: Conversation[];
    thisWeek: Conversation[];
    older: Conversation[];
  };
  activeConversationId: string | null;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onOpenSearch: () => void;
  onOpenExport: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  conversations,
  activeConversationId,
  onNewConversation,
  onSelectConversation,
  onDeleteConversation,
  onOpenSearch,
  onOpenExport,
}: SidebarProps) {
  const renderGroup = (title: string, items: Conversation[]) => {
    if (items.length === 0) return null;

    return (
      <div className="conversation-group">
        <div className="conversation-group-title">{title}</div>
        {items.map((conv) => (
          <ConversationItem
            key={conv.id}
            conversation={conv}
            isActive={conv.id === activeConversationId}
            onSelect={() => onSelectConversation(conv.id)}
            onDelete={() => {
              if (confirm("Delete this conversation?")) {
                onDeleteConversation(conv.id);
              }
            }}
          />
        ))}
      </div>
    );
  };

  const hasConversations =
    conversations.today.length > 0 ||
    conversations.yesterday.length > 0 ||
    conversations.thisWeek.length > 0 ||
    conversations.older.length > 0;

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && <div className="sidebar-overlay" onClick={onClose} />}

      <aside className={cn("sidebar", !isOpen && "collapsed")}>
        <div className="sidebar-header">
          <IconButton onClick={onNewConversation} tooltip="New chat (Ctrl+N)">
            <PlusIcon size={18} />
          </IconButton>
          <IconButton onClick={onOpenSearch} tooltip="Search (Ctrl+K)">
            <SearchIcon size={18} />
          </IconButton>
          <IconButton variant="ghost" onClick={onClose} tooltip="Close sidebar">
            <ChevronLeftIcon size={18} />
          </IconButton>
        </div>

        <div className="sidebar-content">
          {hasConversations ? (
            <div className="conversation-list">
              {renderGroup("Today", conversations.today)}
              {renderGroup("Yesterday", conversations.yesterday)}
              {renderGroup("This Week", conversations.thisWeek)}
              {renderGroup("Older", conversations.older)}
            </div>
          ) : (
            <div className="sidebar-empty" style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "200px",
              color: "var(--text-muted)",
              textAlign: "center",
              padding: "var(--space-lg)",
            }}>
              <MessageIcon size={32} />
              <p style={{ marginTop: "var(--space-md)" }}>No conversations yet</p>
              <button
                onClick={onNewConversation}
                style={{
                  marginTop: "var(--space-md)",
                  padding: "var(--space-sm) var(--space-md)",
                  background: "var(--accent-primary)",
                  color: "white",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                }}
              >
                Start new chat
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <IconButton onClick={onOpenExport} tooltip="Export (Ctrl+E)">
            <DownloadIcon size={18} />
          </IconButton>
          <IconButton tooltip="Settings">
            <SettingsIcon size={18} />
          </IconButton>
        </div>
      </aside>
    </>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
}: ConversationItemProps) {
  return (
    <div
      className={cn("conversation-item", isActive && "active")}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
    >
      <MessageIcon size={16} className="conversation-item-icon" />
      <span className="conversation-item-text">{conversation.title}</span>
      <span className="conversation-item-time">
        {formatRelativeDate(conversation.updatedAt)}
      </span>
      <IconButton
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        tooltip="Delete"
        style={{ opacity: 0, transition: "opacity 0.2s" }}
        className="conversation-delete"
      >
        <TrashIcon size={14} />
      </IconButton>
    </div>
  );
}

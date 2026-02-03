import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Modal } from "../ui/Modal";
import { SearchIcon, MessageIcon } from "../ui/Icons";
import { fuzzySearch, formatRelativeDate, truncate } from "../../utils/helpers";
import type { Conversation, SearchResult } from "../../types";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  onSelectResult: (conversationId: string, messageId: string) => void;
}

export function SearchModal({
  isOpen,
  onClose,
  conversations,
  onSelectResult,
}: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Search results
  const results = useMemo(() => {
    if (!query.trim()) return [];

    const searchResults: SearchResult[] = [];

    for (const conv of conversations) {
      for (const msg of conv.messages) {
        const { matches, score } = fuzzySearch(query, msg.content);
        if (matches) {
          // Find match indices for highlighting
          const lowerContent = msg.content.toLowerCase();
          const lowerQuery = query.toLowerCase();
          const matchStart = lowerContent.indexOf(lowerQuery);
          const matchIndices: [number, number][] =
            matchStart >= 0 ? [[matchStart, matchStart + query.length]] : [];

          searchResults.push({
            messageId: msg.id,
            conversationId: conv.id,
            content: msg.content,
            role: msg.role,
            timestamp: msg.timestamp,
            matchIndices,
          });
        }
      }
    }

    // Sort by timestamp (most recent first)
    return searchResults.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  }, [query, conversations]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) {
            const result = results[selectedIndex];
            onSelectResult(result.conversationId, result.messageId);
            onClose();
          }
          break;
      }
    },
    [results, selectedIndex, onSelectResult, onClose]
  );

  // Scroll selected item into view
  useEffect(() => {
    const selectedEl = resultsRef.current?.children[selectedIndex];
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Highlight matched text
  const highlightMatch = (text: string, indices: [number, number][]) => {
    if (indices.length === 0) {
      return truncate(text, 150);
    }

    const [start, end] = indices[0]!;
    const contextStart = Math.max(0, start - 50);
    const contextEnd = Math.min(text.length, end + 100);

    const before = text.slice(contextStart, start);
    const match = text.slice(start, end);
    const after = text.slice(end, contextEnd);

    return (
      <>
        {contextStart > 0 && "..."}
        {before}
        <mark style={{ background: "var(--accent-muted)", color: "var(--accent-primary)" }}>
          {match}
        </mark>
        {after}
        {contextEnd < text.length && "..."}
      </>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Mesajlarda Ara">
      <div onKeyDown={handleKeyDown}>
        <div className="search-input-wrapper" style={{ marginBottom: "var(--space-md)" }}>
          <SearchIcon size={18} />
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Aramak istediğiniz kelimeyi yazın..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            autoFocus
          />
          {query && (
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
              {results.length} sonuç
            </span>
          )}
        </div>

        <div
          ref={resultsRef}
          style={{
            maxHeight: "400px",
            overflowY: "auto",
          }}
        >
          {query && results.length === 0 && (
            <div
              style={{
                padding: "var(--space-xl)",
                textAlign: "center",
                color: "var(--text-muted)",
              }}
            >
              Sonuç bulunamadı
            </div>
          )}

          {results.map((result, index) => (
            <div
              key={`${result.conversationId}-${result.messageId}`}
              onClick={() => {
                onSelectResult(result.conversationId, result.messageId);
                onClose();
              }}
              style={{
                padding: "var(--space-md)",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                background: index === selectedIndex ? "var(--bg-hover)" : "transparent",
                marginBottom: "var(--space-xs)",
                transition: "background var(--transition-fast)",
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-sm)",
                  marginBottom: "var(--space-xs)",
                }}
              >
                <MessageIcon size={14} />
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: 500,
                    color: result.role === "user" ? "var(--accent-primary)" : "var(--text-secondary)",
                  }}
                >
                  {result.role === "user" ? "Sen" : "Cobrain"}
                </span>
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                    marginLeft: "auto",
                  }}
                >
                  {formatRelativeDate(result.timestamp)}
                </span>
              </div>
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                {highlightMatch(result.content, result.matchIndices)}
              </div>
            </div>
          ))}

          {!query && (
            <div
              style={{
                padding: "var(--space-xl)",
                textAlign: "center",
                color: "var(--text-muted)",
              }}
            >
              <SearchIcon size={32} />
              <p style={{ marginTop: "var(--space-md)" }}>
                Mesajlarınızda arama yapın
              </p>
              <p style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}>
                <kbd
                  style={{
                    padding: "2px 6px",
                    background: "var(--bg-tertiary)",
                    borderRadius: "var(--radius-xs)",
                  }}
                >
                  ↑↓
                </kbd>{" "}
                ile gezin,{" "}
                <kbd
                  style={{
                    padding: "2px 6px",
                    background: "var(--bg-tertiary)",
                    borderRadius: "var(--radius-xs)",
                  }}
                >
                  Enter
                </kbd>{" "}
                ile seçin
              </p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

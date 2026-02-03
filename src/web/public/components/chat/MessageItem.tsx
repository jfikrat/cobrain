import React from "react";
import { CodeBlock } from "./CodeBlock";
import { ToolUsage } from "./ToolUsage";
import { MessageActions } from "./MessageActions";
import { formatTime } from "../../utils/helpers";
import type { Message } from "../../types";

interface MessageItemProps {
  message: Message;
  showActions?: boolean;
  onRegenerate?: () => void;
  onEdit?: () => void;
}

export function MessageItem({
  message,
  showActions = true,
  onRegenerate,
  onEdit,
}: MessageItemProps) {
  // Markdown rendering
  const renderContent = (content: string) => {
    const parts: React.ReactNode[] = [];
    let key = 0;

    // Split by code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        parts.push(
          <span
            key={key++}
            dangerouslySetInnerHTML={{
              __html: renderInlineMarkdown(content.slice(lastIndex, match.index)),
            }}
          />
        );
      }

      // Add code block
      parts.push(
        <CodeBlock key={key++} language={match[1]} code={match[2]?.trim() ?? ""} />
      );

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      parts.push(
        <span
          key={key++}
          dangerouslySetInnerHTML={{
            __html: renderInlineMarkdown(content.slice(lastIndex)),
          }}
        />
      );
    }

    return parts;
  };

  const renderInlineMarkdown = (text: string) => {
    const lines = text.split("\n");
    const processedLines: string[] = [];
    let inList = false;
    let listType: "ul" | "ol" | null = null;
    let inTable = false;
    let tableRows: string[] = [];

    const processInline = (line: string) => {
      return line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.*?)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener">$1</a>'
        );
    };

    const closeList = () => {
      if (inList && listType) {
        processedLines.push(`</${listType}>`);
        inList = false;
        listType = null;
      }
    };

    const closeTable = () => {
      if (inTable && tableRows.length > 0) {
        let tableHtml = '<table class="md-table"><thead><tr>';
        const headerCells = tableRows[0]?.split("|").filter((c) => c.trim()) || [];
        headerCells.forEach((cell) => {
          tableHtml += `<th>${processInline(cell.trim())}</th>`;
        });
        tableHtml += "</tr></thead><tbody>";

        for (let i = 2; i < tableRows.length; i++) {
          const cells = tableRows[i]?.split("|").filter((c) => c.trim()) || [];
          if (cells.length > 0) {
            tableHtml += "<tr>";
            cells.forEach((cell) => {
              tableHtml += `<td>${processInline(cell.trim())}</td>`;
            });
            tableHtml += "</tr>";
          }
        }
        tableHtml += "</tbody></table>";
        processedLines.push(tableHtml);
        inTable = false;
        tableRows = [];
      }
    };

    for (const line of lines) {
      // Table detection
      if (line.includes("|") && line.trim().startsWith("|")) {
        closeList();
        if (!inTable) {
          inTable = true;
        }
        tableRows.push(line);
        continue;
      } else if (inTable) {
        closeTable();
      }

      // Headers
      const h3Match = line.match(/^### (.+)$/);
      const h2Match = line.match(/^## (.+)$/);
      const h1Match = line.match(/^# (.+)$/);

      if (h3Match) {
        closeList();
        processedLines.push(`<h3>${processInline(h3Match[1] ?? "")}</h3>`);
        continue;
      }
      if (h2Match) {
        closeList();
        processedLines.push(`<h2>${processInline(h2Match[1] ?? "")}</h2>`);
        continue;
      }
      if (h1Match) {
        closeList();
        processedLines.push(`<h1>${processInline(h1Match[1] ?? "")}</h1>`);
        continue;
      }

      // Unordered list
      const ulMatch = line.match(/^[\-\*] (.+)$/);
      if (ulMatch) {
        if (!inList || listType !== "ul") {
          closeList();
          processedLines.push("<ul>");
          inList = true;
          listType = "ul";
        }
        processedLines.push(`<li>${processInline(ulMatch[1] ?? "")}</li>`);
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^\d+\. (.+)$/);
      if (olMatch) {
        if (!inList || listType !== "ol") {
          closeList();
          processedLines.push("<ol>");
          inList = true;
          listType = "ol";
        }
        processedLines.push(`<li>${processInline(olMatch[1] ?? "")}</li>`);
        continue;
      }

      // Regular line
      closeList();
      if (line.trim() === "") {
        processedLines.push("<br />");
      } else {
        processedLines.push(processInline(line) + "<br />");
      }
    }

    closeList();
    closeTable();

    return processedLines.join("");
  };

  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === "user" ? "S" : "C"}</div>
      <div className="message-content">
        <div className="message-header">
          <span className="message-role">
            {message.role === "user" ? "Sen" : "Cobrain"}
          </span>
          <span className="message-time">{formatTime(message.timestamp)}</span>
        </div>
        <div className="message-text">{renderContent(message.content)}</div>
        {message.toolUses?.map((tool, i) => (
          <ToolUsage key={i} tool={tool} />
        ))}
        {showActions && message.content && (
          <MessageActions
            message={message}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
            showRegenerate={message.role === "assistant"}
            showEdit={message.role === "user"}
          />
        )}
      </div>
    </div>
  );
}

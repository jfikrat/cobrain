import type { Conversation, Message, ExportOptions } from "../types";
import { downloadFile, formatTime } from "./helpers";

/**
 * Export conversation to Markdown
 */
export function exportToMarkdown(
  conversation: Conversation,
  options: Partial<ExportOptions> = {}
): string {
  const { includeTimestamps = true, includeToolUsage = false } = options;

  let markdown = `# ${conversation.title}\n\n`;

  if (includeTimestamps) {
    markdown += `> Oluşturulma: ${new Date(conversation.createdAt).toLocaleString("tr-TR")}\n`;
    markdown += `> Son güncelleme: ${new Date(conversation.updatedAt).toLocaleString("tr-TR")}\n\n`;
  }

  markdown += `---\n\n`;

  for (const message of conversation.messages) {
    const role = message.role === "user" ? "**Sen**" : "**Cobrain**";
    const time = includeTimestamps ? ` _(${formatTime(message.timestamp)})_` : "";

    markdown += `### ${role}${time}\n\n`;
    markdown += `${message.content}\n\n`;

    if (includeToolUsage && message.toolUses && message.toolUses.length > 0) {
      markdown += `<details>\n<summary>Kullanılan araçlar</summary>\n\n`;
      for (const tool of message.toolUses) {
        markdown += `- **${tool.name}**: ${tool.status}\n`;
      }
      markdown += `\n</details>\n\n`;
    }
  }

  return markdown;
}

/**
 * Export conversation to JSON
 */
export function exportToJson(
  conversation: Conversation,
  options: Partial<ExportOptions> = {}
): string {
  const { includeToolUsage = true } = options;

  const exportData = {
    ...conversation,
    messages: conversation.messages.map((msg) => ({
      ...msg,
      toolUses: includeToolUsage ? msg.toolUses : undefined,
    })),
    exportedAt: new Date().toISOString(),
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Export all conversations
 */
export function exportAllConversations(
  conversations: Conversation[],
  options: Partial<ExportOptions> = {}
): string {
  const { format = "json" } = options;

  if (format === "markdown") {
    return conversations.map((c) => exportToMarkdown(c, options)).join("\n\n---\n\n");
  }

  return JSON.stringify(
    {
      conversations,
      exportedAt: new Date().toISOString(),
      version: "1.0",
    },
    null,
    2
  );
}

/**
 * Download conversation
 */
export function downloadConversation(
  conversation: Conversation,
  format: "markdown" | "json" = "markdown"
) {
  const filename = `cobrain-${conversation.title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "-")}`;

  if (format === "markdown") {
    const content = exportToMarkdown(conversation);
    downloadFile(content, `${filename}.md`, "text/markdown");
  } else {
    const content = exportToJson(conversation);
    downloadFile(content, `${filename}.json`, "application/json");
  }
}

/**
 * Download all conversations
 */
export function downloadAllConversations(
  conversations: Conversation[],
  format: "markdown" | "json" = "json"
) {
  const date = new Date().toISOString().split("T")[0];
  const filename = `cobrain-export-${date}`;

  const content = exportAllConversations(conversations, { format });
  const mimeType = format === "markdown" ? "text/markdown" : "application/json";

  downloadFile(content, `${filename}.${format === "markdown" ? "md" : "json"}`, mimeType);
}

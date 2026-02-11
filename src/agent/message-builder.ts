/**
 * Message content builders and type definitions
 * Extracted from chat.ts for modularity
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Multimodal content types for images
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string; // base64 encoded image
  };
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MessageContent = TextContent | ImageContent;

export interface MultimodalMessage {
  text: string;
  images?: Array<{
    data: string; // base64
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  }>;
}

/**
 * Extract text content from assistant message
 */
export function extractTextContent(message: SDKMessage): string {
  if (message.type !== "assistant") return "";

  const content = message.message.content;
  if (typeof content === "string") return content;

  // Content is an array of blocks
  return (content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

/**
 * Build multimodal content array for Claude API
 */
export function buildMessageContent(message: string | MultimodalMessage): MessageContent[] {
  if (typeof message === "string") {
    return [{ type: "text", text: message }];
  }

  const content: MessageContent[] = [];

  // Add text first
  if (message.text) {
    content.push({ type: "text", text: message.text });
  }

  // Add images
  if (message.images && message.images.length > 0) {
    for (const img of message.images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.data,
        },
      });
    }
  }

  return content;
}

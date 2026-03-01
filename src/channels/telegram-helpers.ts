import { InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import type { PendingChat } from "../services/whatsapp-db.ts";
import type { PendingMessage } from "../services/whatsapp.ts";
import type { MessageAnalysis } from "../services/analyzer.ts";

// ============ TYPES ============

export interface ReplyState {
  chatJid: string;
  chatName: string;
  messageId: number; // Telegram mesaj ID (editleyebilmek için)
}

export interface LiveLocationEntry {
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

export interface TelegramContext {
  cachedAnalysis: MessageAnalysis[];
  replyStates: Map<number, ReplyState>;
  liveLocationCache: Map<number, LiveLocationEntry>;
}

// ============ UTILITIES ============

/** Parse <suggestions> block from response, return clean text + suggestions */
export function parseSuggestions(content: string): { text: string; suggestions: string[] } {
  const match = content.match(/<suggestions>\n?([\s\S]*?)\n?<\/suggestions>\s*$/);
  if (!match) return { text: content, suggestions: [] };

  const text = content.replace(/<suggestions>[\s\S]*?<\/suggestions>\s*$/, '').trimEnd();
  const suggestions = match[1]!
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length <= 40)
    .slice(0, 3);

  return { text, suggestions };
}

/** Build inline keyboard from suggestion strings */
export function buildSuggestionKeyboard(suggestions: string[]): InlineKeyboard | undefined {
  if (suggestions.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (const s of suggestions) {
    kb.text(s, s).row();
  }
  return kb;
}

export function isAuthorized(userId: number): boolean {
  return userId === config.MY_TELEGRAM_ID;
}

/** PendingChat -> PendingMessage dönüşümü */
export function toPendingMessage(chat: PendingChat): PendingMessage {
  return {
    id: chat.chatJid,
    chatId: chat.chatJid,
    chatName: chat.chatName,
    senderName: chat.senderName,
    message: chat.lastMessage,
    timestamp: chat.lastMessageTime,
    isGroup: chat.isGroup,
    waitingMinutes: chat.waitingMinutes,
  };
}

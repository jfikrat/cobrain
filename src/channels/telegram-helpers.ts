import { InlineKeyboard, type Context } from "grammy";
import { config } from "../config.ts";

// ============ TYPES ============

export interface LiveLocationEntry {
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

export interface TelegramContext {
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

export async function withTypingIndicator<T>(
  ctx: Context,
  operation: () => Promise<T>,
): Promise<T> {
  await ctx.replyWithChatAction("typing");
  const interval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}

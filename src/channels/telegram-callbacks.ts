import type { Bot } from "grammy";
import { think } from "../brain/index.ts";
import { recordInteraction } from "../services/interaction-tracker.ts";
import { isAuthorized, parseSuggestions, buildSuggestionKeyboard, type TelegramContext } from "./telegram-helpers.ts";

export function registerCallbacks(bot: Bot, _ctx: TelegramContext) {
  // ============ GENERIC ACK ============

  bot.callbackQuery(/^(restart_ack|ack)$/, async (c) => {
    await c.answerCallbackQuery("OK");
    await c.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  });

  // ============ CATCH-ALL (AI suggestion buttons) ============

  bot.callbackQuery(/.+/, async (c) => {
    const userId = c.from?.id ?? 0;
    const data = c.callbackQuery.data;

    await c.answerCallbackQuery();

    if (!isAuthorized(userId)) return;

    console.log(`[Telegram] Unhandled callback from ${userId}: "${data}"`);

    try {
      await c.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch { /* message already deleted or cannot be edited */ }

    recordInteraction(userId);

    await c.reply(`💬 ${data}`);

    await c.replyWithChatAction("typing");

    const response = await think(userId, data);
    if (response.content) {
      const { text: cleanContent, suggestions } = parseSuggestions(response.content);
      const replyMarkup = buildSuggestionKeyboard(suggestions);
      try {
        await c.reply(cleanContent, {
          parse_mode: "HTML",
          ...(replyMarkup && { reply_markup: replyMarkup }),
        });
      } catch {
        await c.reply(cleanContent, {
          ...(replyMarkup && { reply_markup: replyMarkup }),
        });
      }
    }
  });
}

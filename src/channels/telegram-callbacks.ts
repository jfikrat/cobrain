import type { Bot } from "grammy";
import { think } from "../brain/index.ts";
import { recordInteraction } from "../services/interaction-tracker.ts";
import { isAuthorized, parseSuggestions, buildSuggestionKeyboard, type TelegramContext } from "./telegram-helpers.ts";

export function registerCallbacks(bot: Bot, ctx: TelegramContext) {
  // ============ MOOD CALLBACK ============

  bot.callbackQuery(/^mood_(great|neutral|low)$/, async (c) => {
    const data = c.callbackQuery.data;
    const moodMap: Record<string, string> = { mood_great: "great", mood_neutral: "neutral", mood_low: "low" };
    const mood = moodMap[data];
    if (!mood) return;

    const userId = c.from?.id ?? 0;
    try {
      const { getMoodTrackingService } = await import("../services/mood-tracking.ts");
      const moodService = await getMoodTrackingService(userId);
      moodService.recordMood({
        mood: mood as "great" | "neutral" | "low",
        energy: mood === "great" ? 4 : mood === "neutral" ? 3 : 2,
        source: "explicit",
      });
      await c.answerCallbackQuery({ text: "Kaydedildi!" });
      await c.editMessageReplyMarkup({ reply_markup: undefined });
    } catch (err) {
      console.error("[MoodCallback] Failed:", err);
      await c.answerCallbackQuery({ text: "Hata olustu" });
    }
  });

  // ============ GENERIC ACK ============

  bot.callbackQuery(/^(restart_ack|ack|tamam)$/, async (c) => {
    await c.answerCallbackQuery("Tamam");
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
    } catch { /* mesaj zaten silinmiş veya düzenlenemiyor */ }

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

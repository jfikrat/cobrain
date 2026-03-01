import type { Bot } from "grammy";
import { think } from "../brain/index.ts";
import { whatsappDB } from "../services/whatsapp-db.ts";
import { analyzeMessages, generateSummary } from "../services/analyzer.ts";
import { recordInteraction } from "../services/interaction-tracker.ts";
import {
  formatSummaryMessage,
  formatDetailMessage,
  formatPersonalList,
  formatGroupList,
  formatReplyPrompt,
  getDetailKeyboard,
  getCategoryKeyboard,
  getPersonalListKeyboard,
  getGroupListKeyboard,
  getReplyKeyboard,
} from "../services/notifier.ts";
import { isAuthorized, toPendingMessage, parseSuggestions, buildSuggestionKeyboard, type TelegramContext } from "./telegram-helpers.ts";

export function registerCallbacks(bot: Bot, ctx: TelegramContext) {
  // ============ WHATSAPP INBOX ACTIONS ============

  bot.callbackQuery("action:detail", async (c) => {
    await c.answerCallbackQuery();

    if (ctx.cachedAnalysis.length === 0) {
      await c.editMessageText("✅ Bekleyen mesaj yok!", { parse_mode: "HTML" });
      return;
    }

    await c.editMessageText(formatDetailMessage(ctx.cachedAnalysis), {
      parse_mode: "HTML",
      reply_markup: getDetailKeyboard(),
    });
  });

  bot.callbackQuery("action:suggestions", async (c) => {
    await c.answerCallbackQuery();

    if (ctx.cachedAnalysis.length === 0) {
      await c.editMessageText("✅ Bekleyen mesaj yok!");
      return;
    }

    let text = `💬 <b>Cevap Önerileri</b>\n\n`;

    for (const m of ctx.cachedAnalysis) {
      if (m.suggestedReply) {
        text += `<b>${m.chatName}:</b>\n`;
        text += `└ <i>"${m.suggestedReply}"</i>\n\n`;
      }
    }

    if (text === `💬 <b>Cevap Önerileri</b>\n\n`) {
      text += "Öneri üretilemedi.";
    }

    await c.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: getDetailKeyboard(),
    });
  });

  bot.callbackQuery("action:summary", async (c) => {
    await c.answerCallbackQuery();

    const summary = await generateSummary(ctx.cachedAnalysis);

    await c.editMessageText(formatSummaryMessage(summary), {
      parse_mode: "HTML",
      reply_markup: getCategoryKeyboard(summary),
    });
  });

  bot.callbackQuery("action:refresh", async (c) => {
    await c.answerCallbackQuery("🔄 Yenileniyor...");

    try {
      const pendingChats = whatsappDB.getPendingChats(24);
      const pendingMessages = pendingChats.map(toPendingMessage);
      ctx.cachedAnalysis = await analyzeMessages(pendingMessages);
      const summary = await generateSummary(ctx.cachedAnalysis);

      await c.editMessageText(formatSummaryMessage(summary), {
        parse_mode: "HTML",
        reply_markup: getCategoryKeyboard(summary),
      });
    } catch (error) {
      await c.editMessageText(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen"}`);
    }
  });

  bot.callbackQuery("action:dismiss", async (c) => {
    await c.answerCallbackQuery("✅ Tamam");
    await c.editMessageText("✅ Mesajlar görüldü olarak işaretlendi.", {
      parse_mode: "HTML",
    });
    ctx.cachedAnalysis = [];
  });

  // ============ CATEGORY FILTERS ============

  bot.callbackQuery("category:personal", async (c) => {
    await c.answerCallbackQuery();

    if (ctx.cachedAnalysis.length === 0) {
      await c.editMessageText("✅ Bekleyen mesaj yok!", { parse_mode: "HTML" });
      return;
    }

    await c.editMessageText(formatPersonalList(ctx.cachedAnalysis), {
      parse_mode: "HTML",
      reply_markup: getPersonalListKeyboard(ctx.cachedAnalysis),
    });
  });

  bot.callbackQuery("category:groups", async (c) => {
    await c.answerCallbackQuery();

    if (ctx.cachedAnalysis.length === 0) {
      await c.editMessageText("✅ Bekleyen mesaj yok!", { parse_mode: "HTML" });
      return;
    }

    await c.editMessageText(formatGroupList(ctx.cachedAnalysis), {
      parse_mode: "HTML",
      reply_markup: getGroupListKeyboard(ctx.cachedAnalysis),
    });
  });

  // ============ REPLY FLOW ============

  bot.callbackQuery(/^reply_start:(.+):(\d+)$/, async (c) => {
    await c.answerCallbackQuery();

    const match = c.callbackQuery.data.match(/^reply_start:(.+):(\d+)$/);
    if (!match) return;

    const chatJid = match[1] ?? "";
    const userId = c.from?.id ?? 0;

    const msg = ctx.cachedAnalysis.find((m) => m.chatJid === chatJid);
    if (!msg) {
      await c.editMessageText("❌ Mesaj bulunamadı.", { parse_mode: "HTML" });
      return;
    }

    ctx.replyStates.set(userId, {
      chatJid,
      chatName: msg.chatName,
      messageId: c.callbackQuery.message?.message_id ?? 0,
    });

    await c.editMessageText(formatReplyPrompt(msg), {
      parse_mode: "HTML",
      reply_markup: getReplyKeyboard(),
    });
  });

  bot.callbackQuery("reply_cancel", async (c) => {
    await c.answerCallbackQuery("❌ İptal edildi");

    const userId = c.from?.id ?? 0;
    ctx.replyStates.delete(userId);

    const summary = await generateSummary(ctx.cachedAnalysis);

    await c.editMessageText(formatSummaryMessage(summary), {
      parse_mode: "HTML",
      reply_markup: getCategoryKeyboard(summary),
    });
  });

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

import type { Bot } from "grammy";
import { config } from "../config.ts";
import { think, userManager, type MultimodalMessage } from "../brain/index.ts";
import { recordInteraction, extractMoodFromMessage, recordUserActivity } from "../services/interaction-tracker.ts";
import { transcribeAudio, downloadTelegramFileAsBuffer } from "../services/transcribe.ts";
import { isAuthorized, parseSuggestions, buildSuggestionKeyboard, type TelegramContext } from "./telegram-helpers.ts";
import { getGroupRoute, handleGroupMessage, getTopicRoute, handleTopicMessage } from "./telegram-router.ts";

// Live location log throttle
const liveLocationLastLog = new Map<number, number>();
const LIVE_LOCATION_LOG_INTERVAL = 30 * 60 * 1000; // 30 dakika

async function handleLocationUpdate(userId: number, latitude: number, longitude: number, isLive: boolean, isUpdate: boolean) {
  const locationType = isLive ? "canlı konum" : "konum";
  const updateNote = isUpdate ? " (güncelleme)" : "";

  const locationText = `Kullanıcı Telegram'dan ${locationType} paylaştı${updateNote}: latitude=${latitude}, longitude=${longitude}

Bu konumu analiz et:
1. Reverse geocode yaparak adresini bul
2. Kullanıcıya kısaca nerede olduğunu söyle (sadece adres, kısa)
3. Eğer bağlamda konum kaydetme/mesafe hesaplama varsa o bağlamda kullan`;

  await userManager.ensureUser(userId);
  const response = await think(userId, locationText);
  return response.content;
}

export function registerMessageHandlers(bot: Bot, ctx: TelegramContext) {
  // ============ SES MESAJI ============

  bot.on("message:voice", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Yetkisiz ses mesajı: ${userId}`);
      return;
    }

    recordInteraction(userId);

    if (!config.GEMINI_API_KEY) {
      await c.reply("❌ Ses tanıma yapılandırılmamış (GEMINI_API_KEY eksik)");
      return;
    }

    await c.replyWithChatAction("typing");

    try {
      const file = await c.getFile();
      if (!file.file_path) {
        await c.reply("❌ Ses dosyası indirilemedi");
        return;
      }

      const audioBuffer = await downloadTelegramFileAsBuffer(file.file_path, config.TELEGRAM_BOT_TOKEN);
      const transcript = await transcribeAudio(audioBuffer, "audio/ogg");

      if (!transcript.trim() || transcript.includes("[ses kaydı boş veya anlaşılmıyor]")) {
        await c.reply("Ses anlasilamadi, tekrar dener misin?");
        return;
      }

      console.log(`[Voice] ${userId}: "${transcript.slice(0, 50)}..."`);

      // Hub topic routing for voice
      const threadId = c.message.message_thread_id;
      if (
        c.chat.type === "supergroup" &&
        config.COBRAIN_HUB_ID &&
        c.chat.id === config.COBRAIN_HUB_ID &&
        threadId
      ) {
        const topicRoute = getTopicRoute(threadId);
        if (topicRoute) {
          await c.replyWithChatAction("typing");
          const topicVoiceInterval = setInterval(() => {
            c.replyWithChatAction("typing").catch(() => {});
          }, 4000);
          try {
            const topicResponse = await handleTopicMessage(userId, c.chat.id, threadId, topicRoute, transcript);
            clearInterval(topicVoiceInterval);
            const voiceMsg = `🎤 <i>${transcript}</i>\n\n${topicResponse}`;
            await c.reply(voiceMsg, { parse_mode: "HTML", message_thread_id: threadId })
              .catch(() => c.reply(`🎤 ${transcript}\n\n${topicResponse}`, { message_thread_id: threadId }));
          } catch (err) {
            clearInterval(topicVoiceInterval);
            console.error(`[TG Hub] Voice topic hata (${topicRoute.name}):`, err);
          }
          return;
        }
      }

      await c.replyWithChatAction("typing");
      const voiceTypingInterval = setInterval(() => {
        c.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      let response;
      try {
        response = await think(userId, transcript);
      } finally {
        clearInterval(voiceTypingInterval);
      }

      const { text: cleanVoice, suggestions: voiceSuggestions } = parseSuggestions(response.content);
      const voiceKeyboard = buildSuggestionKeyboard(voiceSuggestions);
      const message = `🎤 <i>${transcript}</i>\n\n${cleanVoice}`;

      try {
        await c.reply(message, {
          parse_mode: "HTML",
          ...(voiceKeyboard && { reply_markup: voiceKeyboard }),
        });
      } catch {
        await c.reply(`🎤 ${transcript}\n\n${cleanVoice}`, {
          ...(voiceKeyboard && { reply_markup: voiceKeyboard }),
        });
      }

      console.log(
        `[${userId}] 🎤 ${transcript.slice(0, 30)}... -> ${response.inputTokens}/${response.outputTokens} tokens`
      );
    } catch (error) {
      console.error("Ses işleme hatası:", error);
      await c.reply(`❌ Ses işlenemedi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  });

  // ============ RESİM MESAJI ============

  bot.on("message:photo", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Yetkisiz erişim denemesi: ${userId}`);
      return;
    }

    recordInteraction(userId);

    try {
      const processingMsg = await c.reply("🖼️ Resim işleniyor...");

      const photo = c.message.photo[c.message.photo.length - 1];
      if (!photo?.file_id) {
        await c.reply("Resim alınamadı!");
        return;
      }

      const file = await bot.api.getFile(photo.file_id);
      const filePath = file.file_path;
      if (!filePath) {
        await c.reply("Resim dosya yolu alınamadı!");
        return;
      }

      const imageBuffer = await downloadTelegramFileAsBuffer(filePath, config.TELEGRAM_BOT_TOKEN);
      const base64Image = imageBuffer.toString("base64");

      const extension = filePath.split(".").pop()?.toLowerCase() || "jpg";
      const mediaTypeMap: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
      };
      const mediaType = mediaTypeMap[extension] || "image/jpeg";

      const caption = c.message.caption || "";
      const prompt = caption
        ? `Kullanıcı bu resmi gönderdi ve şunu söyledi: "${caption}"\n\nResmi analiz et ve cevap ver.`
        : "Kullanıcı bu resmi gönderdi. Resimde ne görüyorsun? Detaylı açıkla.";

      const multimodalMessage: MultimodalMessage = {
        text: prompt,
        images: [
          {
            data: base64Image,
            mediaType: mediaType,
          },
        ],
      };

      // Hub topic routing for photos — route to topic agent as text prompt
      const photoThreadId = c.message.message_thread_id;
      if (
        c.chat.type === "supergroup" &&
        config.COBRAIN_HUB_ID &&
        c.chat.id === config.COBRAIN_HUB_ID &&
        photoThreadId
      ) {
        const topicRoute = getTopicRoute(photoThreadId);
        if (topicRoute) {
          try { await bot.api.deleteMessage(c.chat.id, processingMsg.message_id); } catch {}
          const photoPrompt = caption
            ? `[Kullanıcı bir resim gönderdi: "${caption}"] Resmi göremiyorsun ama açıklama ile yardımcı ol.`
            : "[Kullanıcı bir resim gönderdi] Resmi göremiyorsun, bunu belirt.";
          const topicPhotoResponse = await handleTopicMessage(userId, c.chat.id, photoThreadId, topicRoute, photoPrompt);
          await c.reply(topicPhotoResponse, { message_thread_id: photoThreadId })
            .catch(() => c.reply(topicPhotoResponse, { message_thread_id: photoThreadId }));
          return;
        }
      }

      await userManager.ensureUser(userId);
      const response = await think(userId, multimodalMessage);

      try {
        await bot.api.deleteMessage(userId, processingMsg.message_id);
      } catch {}

      const { text: cleanPhoto, suggestions: photoSuggestions } = parseSuggestions(response.content);
      const photoKeyboard = buildSuggestionKeyboard(photoSuggestions);
      try {
        await c.reply(cleanPhoto, {
          parse_mode: "HTML",
          ...(photoKeyboard && { reply_markup: photoKeyboard }),
        });
      } catch {
        await c.reply(cleanPhoto, {
          ...(photoKeyboard && { reply_markup: photoKeyboard }),
        });
      }
    } catch (error) {
      console.error("Photo handler error:", error);
      await c.reply("❌ Resim işlenirken hata oluştu!");
    }
  });

  // ============ KONUM MESAJI ============

  bot.on("message:location", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Yetkisiz erişim denemesi: ${userId}`);
      return;
    }

    recordInteraction(userId);

    try {
      const { latitude, longitude, live_period } = c.message.location;
      const isLive = !!live_period;

      if (isLive) {
        ctx.liveLocationCache.set(userId, { latitude, longitude, updatedAt: new Date() });
        console.log(`[LiveLocation] ${userId} started: ${latitude},${longitude}`);
        return;
      }

      const content = await handleLocationUpdate(userId, latitude, longitude, false, false);

      try {
        await c.reply(content, { parse_mode: "HTML" });
      } catch {
        await c.reply(content);
      }

      console.log(`[Location] ${userId}: ${latitude},${longitude}`);
    } catch (error) {
      console.error("Location handler error:", error);
      await c.reply("❌ Konum işlenirken hata oluştu!");
    }
  });

  // Live location güncellemeleri — sadece cache'e yaz
  bot.on("edited_message:location", (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) return;

    try {
      const location = c.editedMessage.location;
      if (!location?.live_period) return;

      const { latitude, longitude } = location;

      ctx.liveLocationCache.set(userId, { latitude, longitude, updatedAt: new Date() });

      const now = Date.now();
      const lastLog = liveLocationLastLog.get(userId) ?? 0;
      if (now - lastLog >= LIVE_LOCATION_LOG_INTERVAL) {
        console.log(`[LiveLocation] ${userId} cached: ${latitude},${longitude}`);
        liveLocationLastLog.set(userId, now);
      }
    } catch (error) {
      console.error("Live location update error:", error);
    }
  });

  // ============ TEXT MESAJI (AI Sohbet) ============

  bot.on("message:text", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Yetkisiz erişim denemesi: ${userId}`);
      return;
    }

    recordInteraction(userId);

    const text = c.message.text;
    if (text.startsWith("/")) return;

    // ============ HUB TOPIC ROUTING ============
    if (
      c.chat.type === "supergroup" &&
      config.COBRAIN_HUB_ID &&
      c.chat.id === config.COBRAIN_HUB_ID
    ) {
      const threadId = c.message.message_thread_id;
      if (threadId) {
        const topicRoute = getTopicRoute(threadId);
        if (topicRoute) {
          await c.replyWithChatAction("typing");
          const topicTypingInterval = setInterval(() => {
            c.replyWithChatAction("typing").catch(() => {});
          }, 4000);

          try {
            const response = await handleTopicMessage(userId, c.chat.id, threadId, topicRoute, text);
            clearInterval(topicTypingInterval);
            const { text: clean, suggestions } = parseSuggestions(response);
            const keyboard = buildSuggestionKeyboard(suggestions);
            await c.reply(clean, {
              parse_mode: "Markdown",
              message_thread_id: threadId,
              ...(keyboard && { reply_markup: keyboard }),
            }).catch(() =>
              c.reply(clean, {
                message_thread_id: threadId,
                ...(keyboard && { reply_markup: keyboard }),
              })
            );
          } catch (err) {
            clearInterval(topicTypingInterval);
            console.error(`[TG Hub] Topic hata (${topicRoute.name}):`, err);
          }
          return;
        }
      }
      // threadId yoksa veya route yoksa → "Genel" topic → normal Cobrain (fall through)
    }

    // ============ GRUP ROUTING ============
    if (c.chat.type === "group" || c.chat.type === "supergroup") {
      const route = getGroupRoute(c.chat.id);
      if (!route) return; // bilinmeyen grup → sessiz kal

      await c.replyWithChatAction("typing");
      const groupTypingInterval = setInterval(() => {
        c.replyWithChatAction("typing").catch(() => {});
      }, 4000);

      try {
        const response = await handleGroupMessage(userId, c.chat.id, route, text);
        clearInterval(groupTypingInterval);
        const { text: clean, suggestions } = parseSuggestions(response);
        const keyboard = buildSuggestionKeyboard(suggestions);
        await c.reply(clean, { parse_mode: "Markdown", ...(keyboard && { reply_markup: keyboard }) })
          .catch(() => c.reply(clean, { ...(keyboard && { reply_markup: keyboard }) }));
      } catch (err) {
        clearInterval(groupTypingInterval);
        console.error(`[TG Router] Grup hata (${route.name}):`, err);
      }
      return;
    }

    // ============ NORMAL AI SOHBET ============
    await c.replyWithChatAction("typing");
    const typingInterval = setInterval(() => {
      c.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      const response = await think(userId, text);
      clearInterval(typingInterval);

      const { text: cleanContent, suggestions } = parseSuggestions(response.content);
      const replyMarkup = buildSuggestionKeyboard(suggestions);

      try {
        await c.reply(cleanContent, {
          parse_mode: "Markdown",
          ...(replyMarkup && { reply_markup: replyMarkup }),
        });
      } catch (markdownError) {
        console.warn("[Telegram] Markdown parse failed, sending as plain text");
        await c.reply(cleanContent, {
          ...(replyMarkup && { reply_markup: replyMarkup }),
        });
      }

      console.log(
        `[${userId}] ${text.slice(0, 30)}... -> ${response.inputTokens}/${response.outputTokens} tokens | $${response.costUsd.toFixed(4)}`
      );

      recordUserActivity(userId);

      extractMoodFromMessage(userId, text, response.content).catch((err) => {
        console.warn("[Telegram] Mood extraction failed:", err);
      });
    } catch (error) {
      clearInterval(typingInterval);
      console.error("Chat hatası:", error);
      const errorMessage = error instanceof Error ? error.message : "Bilinmeyen hata";
      await c.reply(`❌ Hata: ${errorMessage}`);
    }
  });
}

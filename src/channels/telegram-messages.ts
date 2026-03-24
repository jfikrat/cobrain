import type { Bot } from "grammy";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../config.ts";
import { think, userManager, type MultimodalMessage } from "../brain/index.ts";
import { recordInteraction } from "../services/interaction-tracker.ts";
import { transcribeAudio, downloadTelegramFileAsBuffer, EMPTY_TRANSCRIPT_SENTINEL } from "../services/transcribe.ts";
import { isAuthorized, parseSuggestions, buildSuggestionKeyboard, withTypingIndicator, type TelegramContext } from "./telegram-helpers.ts";
import { getTopicRoute, handleTopicMessage } from "./telegram-router.ts";

// Live location log throttle
const liveLocationLastLog = new Map<number, number>();
const LIVE_LOCATION_LOG_INTERVAL = 30 * 60 * 1000; // 30 minutes

async function handleLocationUpdate(userId: number, latitude: number, longitude: number, isLive: boolean, isUpdate: boolean) {
  const locationType = isLive ? "live location" : "location";
  const updateNote = isUpdate ? " (update)" : "";

  const locationText = `The user shared a ${locationType} on Telegram${updateNote}: latitude=${latitude}, longitude=${longitude}

Analyze this location:
1. Find the address via reverse geocoding
2. Briefly tell the user where they are (address only, short)
3. If the context involves saving location or calculating distance, use it in that context`;

  await userManager.ensureUser(userId);
  const response = await think(userId, locationText);
  return response.content;
}

export function registerMessageHandlers(bot: Bot, ctx: TelegramContext) {
  // ============ VOICE MESSAGE ============

  bot.on("message:voice", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Unauthorized voice message: ${userId}`);
      return;
    }

    recordInteraction(userId);

    if (!config.GEMINI_API_KEY) {
      await c.reply("❌ Voice transcription is not configured (GEMINI_API_KEY missing)");
      return;
    }

    await c.replyWithChatAction("typing");

    try {
      const file = await c.getFile();
      if (!file.file_path) {
        await c.reply("❌ Could not download voice file");
        return;
      }

      const audioBuffer = await downloadTelegramFileAsBuffer(file.file_path, config.TELEGRAM_BOT_TOKEN);
      const transcript = await transcribeAudio(audioBuffer, "audio/ogg");

      if (!transcript.trim() || transcript.includes(EMPTY_TRANSCRIPT_SENTINEL)) {
        await c.reply("I couldn't understand the voice message. Can you try again?");
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
          try {
            const topicResponse = await withTypingIndicator(c, () =>
              handleTopicMessage(userId, c.chat.id, threadId, topicRoute, transcript));
            const voiceMsg = `🎤 <i>${transcript}</i>\n\n${topicResponse}`;
            await c.reply(voiceMsg, { parse_mode: "HTML", message_thread_id: threadId })
              .catch(() => c.reply(`🎤 ${transcript}\n\n${topicResponse}`, { message_thread_id: threadId }));
          } catch (err) {
            console.error(`[TG Hub] Voice topic error (${topicRoute.name}):`, err);
          }
          return;
        }
      }

      const response = await withTypingIndicator(c, () => think(userId, transcript));

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
      console.error("Voice processing error:", error);
      await c.reply(`❌ Voice could not be processed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // ============ DOCUMENT / FILE MESSAGE ============

  bot.on("message:document", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Unauthorized document: ${userId}`);
      return;
    }

    recordInteraction(userId);

    const doc = c.message.document;
    if (!doc?.file_id) {
      await c.reply("❌ Could not get document info");
      return;
    }

    const fileName = doc.file_name || `file_${Date.now()}`;
    const fileSize = doc.file_size || 0;
    const mimeType = doc.mime_type || "application/octet-stream";

    // Telegram Bot API limit: 20MB for file downloads
    if (fileSize > 20 * 1024 * 1024) {
      await c.reply(`❌ Dosya çok büyük (${(fileSize / 1024 / 1024).toFixed(1)}MB). Telegram bot limiti 20MB. Google Drive üzerinden gönderebilirsin.`);
      return;
    }

    await c.replyWithChatAction("typing");

    try {
      // Create uploads dir: ~/.cobrain/users/{userId}/uploads/
      const uploadsDir = join(config.COBRAIN_BASE_PATH, "users", String(userId), "uploads");
      await mkdir(uploadsDir, { recursive: true });

      // Download file from Telegram
      const file = await c.getFile();
      if (!file.file_path) {
        await c.reply("❌ Could not download file");
        return;
      }

      const fileBuffer = await downloadTelegramFileAsBuffer(file.file_path, config.TELEGRAM_BOT_TOKEN);

      // Save with timestamp prefix to avoid collisions
      const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const savedPath = join(uploadsDir, safeName);
      await writeFile(savedPath, fileBuffer);

      const caption = c.message.caption || "";
      const sizeStr = fileSize > 1024 * 1024
        ? `${(fileSize / 1024 / 1024).toFixed(1)}MB`
        : `${(fileSize / 1024).toFixed(0)}KB`;

      const prompt = caption
        ? `The user sent a file via Telegram and said: "${caption}"\n\nFile details:\n- Name: ${fileName}\n- Size: ${sizeStr}\n- Type: ${mimeType}\n- Saved to: ${savedPath}\n\nAcknowledge the file and process accordingly.`
        : `The user sent a file via Telegram.\n\nFile details:\n- Name: ${fileName}\n- Size: ${sizeStr}\n- Type: ${mimeType}\n- Saved to: ${savedPath}\n\nAcknowledge the file. If it's a readable format (text, code, PDF, etc.), you can read it with the Read tool.`;

      console.log(`[Document] ${userId}: ${fileName} (${sizeStr}, ${mimeType}) -> ${savedPath}`);

      // Hub topic routing for documents
      const docThreadId = c.message.message_thread_id;
      if (
        c.chat.type === "supergroup" &&
        config.COBRAIN_HUB_ID &&
        c.chat.id === config.COBRAIN_HUB_ID &&
        docThreadId
      ) {
        const topicRoute = getTopicRoute(docThreadId);
        if (topicRoute) {
          try {
            const topicResponse = await withTypingIndicator(c, () =>
              handleTopicMessage(userId, c.chat.id, docThreadId, topicRoute, prompt));
            const { text: cleanTopicDoc, suggestions: topicDocSuggestions } = parseSuggestions(topicResponse);
            const topicDocKeyboard = buildSuggestionKeyboard(topicDocSuggestions);
            await c.reply(cleanTopicDoc, {
              parse_mode: "Markdown",
              message_thread_id: docThreadId,
              ...(topicDocKeyboard && { reply_markup: topicDocKeyboard }),
            }).catch(() =>
              c.reply(cleanTopicDoc, {
                message_thread_id: docThreadId,
                ...(topicDocKeyboard && { reply_markup: topicDocKeyboard }),
              })
            );
          } catch (err) {
            console.error(`[TG Hub] Document topic error (${topicRoute.name}):`, err);
          }
          return;
        }
      }

      // Normal chat
      await userManager.ensureUser(userId);
      const response = await withTypingIndicator(c, () => think(userId, prompt));

      const { text: cleanDoc, suggestions: docSuggestions } = parseSuggestions(response.content);
      const docKeyboard = buildSuggestionKeyboard(docSuggestions);

      try {
        await c.reply(cleanDoc, {
          parse_mode: "HTML",
          ...(docKeyboard && { reply_markup: docKeyboard }),
        });
      } catch {
        await c.reply(cleanDoc, {
          ...(docKeyboard && { reply_markup: docKeyboard }),
        });
      }
    } catch (error) {
      console.error("Document handler error:", error);
      await c.reply(`❌ Dosya işlenirken hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  });

  // ============ IMAGE MESSAGE ============

  bot.on("message:photo", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Unauthorized access attempt: ${userId}`);
      return;
    }

    recordInteraction(userId);

    try {
      const processingMsg = await c.reply("🖼️ Processing image...");

      const photo = c.message.photo[c.message.photo.length - 1];
      if (!photo?.file_id) {
        await c.reply("Could not get image!");
        return;
      }

      const file = await bot.api.getFile(photo.file_id);
      const filePath = file.file_path;
      if (!filePath) {
        await c.reply("Could not get image file path!");
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
        ? `The user sent this image and said: "${caption}"\n\nAnalyze the image and reply.`
        : "The user sent this image. What do you see in it? Describe in detail.";

      const multimodalMessage: MultimodalMessage = {
        text: prompt,
        images: [
          {
            data: base64Image,
            mediaType: mediaType,
          },
        ],
      };

      // Hub topic routing for photos — forward image as multimodal message
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
          const topicPhotoResponse = await withTypingIndicator(c, () =>
            handleTopicMessage(userId, c.chat.id, photoThreadId, topicRoute, multimodalMessage));
          const { text: cleanTopicPhoto, suggestions: topicPhotoSuggestions } = parseSuggestions(topicPhotoResponse);
          const topicPhotoKeyboard = buildSuggestionKeyboard(topicPhotoSuggestions);
          await c.reply(cleanTopicPhoto, {
            parse_mode: "Markdown",
            message_thread_id: photoThreadId,
            ...(topicPhotoKeyboard && { reply_markup: topicPhotoKeyboard }),
          }).catch(() =>
            c.reply(cleanTopicPhoto, {
              message_thread_id: photoThreadId,
              ...(topicPhotoKeyboard && { reply_markup: topicPhotoKeyboard }),
            })
          );
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
      await c.reply("❌ An error occurred while processing the image!");
    }
  });

  // ============ LOCATION MESSAGE ============

  bot.on("message:location", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Unauthorized access attempt: ${userId}`);
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
      await c.reply("❌ An error occurred while processing the location!");
    }
  });

  // Live location updates - only write to cache
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

  // ============ TEXT MESSAGE (AI Chat) ============

  bot.on("message:text", async (c) => {
    const userId = c.from?.id ?? 0;

    if (!isAuthorized(userId)) {
      console.log(`Unauthorized access attempt: ${userId}`);
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
          try {
            const response = await withTypingIndicator(c, () =>
              handleTopicMessage(userId, c.chat.id, threadId, topicRoute, text));
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
            console.error(`[TG Hub] Topic error (${topicRoute.name}):`, err);
          }
          return;
        }
      }
      // No threadId or no route → "General" topic → normal Cobrain (fall through)
    }

    // ============ NORMAL AI CHAT ============
    try {
      const response = await withTypingIndicator(c, () => think(userId, text));

      const { text: cleanContent, suggestions } = parseSuggestions(response.content);
      const replyMarkup = buildSuggestionKeyboard(suggestions);

      // Build footer with model, mode, token stats
      const settings = await userManager.getUserSettings(userId);
      const mode = settings.permissionMode || config.PERMISSION_MODE;
      const userModel = settings.model || config.AGENT_MODEL;
      const modelShort = userModel.replace("claude-", "").replace("-", " ");
      const tokens = `${response.inputTokens}→${response.outputTokens}`;
      const cost = `$${response.costUsd.toFixed(4)}`;
      const footer = `\n\n_${modelShort} · ${mode} · ${tokens} · ${cost}_`;
      const contentWithFooter = cleanContent + footer;

      try {
        await c.reply(contentWithFooter, {
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

    } catch (error) {
      console.error("Chat error:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await c.reply(`❌ Error: ${errorMessage}`);
    }
  });
}

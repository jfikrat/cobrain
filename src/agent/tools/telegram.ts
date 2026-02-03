/**
 * Telegram MCP Server
 * Exposes Telegram bot capabilities to the agent
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Bot } from "grammy";
import { InputFile } from "grammy";

// Bot reference (set during init)
let telegramBot: Bot | null = null;

/**
 * Initialize Telegram MCP with bot instance
 */
export function initTelegramMcp(bot: Bot): void {
  telegramBot = bot;
  console.log("[TelegramMCP] Initialized with bot instance");
}

// ============ TOOL DEFINITIONS ============

const sendPhotoTool = tool(
  "telegram_send_photo",
  "Telegram'dan kullanıcıya resim gönderir. Dosya yolu veya URL olabilir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    photo: z.string().describe("Resim dosya yolu veya URL"),
    caption: z.string().optional().describe("Resim açıklaması"),
  },
  async ({ userId, photo, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const photoSource = photo.startsWith("http") ? photo : new InputFile(photo);

    await telegramBot.api.sendPhoto(userId, photoSource, { caption });

    return { success: true, message: "Resim gönderildi" };
  }
);

const sendDocumentTool = tool(
  "telegram_send_document",
  "Telegram'dan kullanıcıya dosya gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    document: z.string().describe("Dosya yolu"),
    caption: z.string().optional().describe("Dosya açıklaması"),
    filename: z.string().optional().describe("Görüntülenecek dosya adı"),
  },
  async ({ userId, document, caption, filename }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const file = new InputFile(document, filename);

    await telegramBot.api.sendDocument(userId, file, { caption });

    return { success: true, message: "Dosya gönderildi" };
  }
);

const sendVoiceTool = tool(
  "telegram_send_voice",
  "Telegram'dan kullanıcıya ses mesajı gönderir (.ogg formatında).",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    voice: z.string().describe("Ses dosyası yolu (.ogg)"),
    caption: z.string().optional().describe("Açıklama"),
  },
  async ({ userId, voice, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendVoice(userId, new InputFile(voice), { caption });

    return { success: true, message: "Ses mesajı gönderildi" };
  }
);

const sendVideoTool = tool(
  "telegram_send_video",
  "Telegram'dan kullanıcıya video gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    video: z.string().describe("Video dosya yolu veya URL"),
    caption: z.string().optional().describe("Video açıklaması"),
  },
  async ({ userId, video, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const videoSource = video.startsWith("http") ? video : new InputFile(video);

    await telegramBot.api.sendVideo(userId, videoSource, { caption });

    return { success: true, message: "Video gönderildi" };
  }
);

const sendLocationTool = tool(
  "telegram_send_location",
  "Telegram'dan kullanıcıya konum gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    latitude: z.number().describe("Enlem"),
    longitude: z.number().describe("Boylam"),
  },
  async ({ userId, latitude, longitude }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendLocation(userId, latitude, longitude);

    return { success: true, message: "Konum gönderildi" };
  }
);

const sendStickerTool = tool(
  "telegram_send_sticker",
  "Telegram'dan kullanıcıya sticker gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    sticker: z.string().describe("Sticker file_id veya URL"),
  },
  async ({ userId, sticker }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendSticker(userId, sticker);

    return { success: true, message: "Sticker gönderildi" };
  }
);

const sendPollTool = tool(
  "telegram_send_poll",
  "Telegram'dan kullanıcıya anket gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    question: z.string().describe("Anket sorusu"),
    options: z.array(z.string()).describe("Seçenekler (en az 2)"),
    isAnonymous: z.boolean().optional().describe("Anonim mi?"),
    allowsMultipleAnswers: z.boolean().optional().describe("Çoklu cevap?"),
  },
  async ({ userId, question, options, isAnonymous, allowsMultipleAnswers }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendPoll(userId, question, options, {
      is_anonymous: isAnonymous ?? true,
      allows_multiple_answers: allowsMultipleAnswers ?? false,
    });

    return { success: true, message: "Anket gönderildi" };
  }
);

const editMessageTool = tool(
  "telegram_edit_message",
  "Telegram'da gönderilmiş bir mesajı düzenler.",
  {
    userId: z.number().describe("Chat/kullanıcı ID"),
    messageId: z.number().describe("Düzenlenecek mesaj ID"),
    text: z.string().describe("Yeni mesaj içeriği"),
  },
  async ({ userId, messageId, text }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.editMessageText(userId, messageId, text);

    return { success: true, message: "Mesaj düzenlendi" };
  }
);

const deleteMessageTool = tool(
  "telegram_delete_message",
  "Telegram'da bir mesajı siler.",
  {
    userId: z.number().describe("Chat/kullanıcı ID"),
    messageId: z.number().describe("Silinecek mesaj ID"),
  },
  async ({ userId, messageId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.deleteMessage(userId, messageId);

    return { success: true, message: "Mesaj silindi" };
  }
);

const pinMessageTool = tool(
  "telegram_pin_message",
  "Telegram'da bir mesajı sabitler.",
  {
    userId: z.number().describe("Chat/kullanıcı ID"),
    messageId: z.number().describe("Sabitlenecek mesaj ID"),
    disableNotification: z.boolean().optional().describe("Sessiz sabitle?"),
  },
  async ({ userId, messageId, disableNotification }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.pinChatMessage(userId, messageId, {
      disable_notification: disableNotification ?? false,
    });

    return { success: true, message: "Mesaj sabitlendi" };
  }
);

const unpinMessageTool = tool(
  "telegram_unpin_message",
  "Telegram'da sabitlenmiş mesajı kaldırır. messageId verilmezse tüm sabitlemeler kaldırılır.",
  {
    userId: z.number().describe("Chat/kullanıcı ID"),
    messageId: z.number().optional().describe("Mesaj ID (verilmezse tümü)"),
  },
  async ({ userId, messageId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    if (messageId) {
      await telegramBot.api.unpinChatMessage(userId);
    } else {
      await telegramBot.api.unpinAllChatMessages(userId);
    }

    return { success: true, message: "Sabitleme kaldırıldı" };
  }
);

const sendAnimationTool = tool(
  "telegram_send_animation",
  "Telegram'dan kullanıcıya GIF/animasyon gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    animation: z.string().describe("GIF dosya yolu veya URL"),
    caption: z.string().optional().describe("Açıklama"),
  },
  async ({ userId, animation, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const animSource = animation.startsWith("http") ? animation : new InputFile(animation);

    await telegramBot.api.sendAnimation(userId, animSource, { caption });

    return { success: true, message: "Animasyon gönderildi" };
  }
);

const forwardMessageTool = tool(
  "telegram_forward_message",
  "Telegram'da bir mesajı başka bir chat'e iletir.",
  {
    toChatId: z.number().describe("Hedef chat ID"),
    fromChatId: z.number().describe("Kaynak chat ID"),
    messageId: z.number().describe("İletilecek mesaj ID"),
  },
  async ({ toChatId, fromChatId, messageId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.forwardMessage(toChatId, fromChatId, messageId);

    return { success: true, message: "Mesaj iletildi" };
  }
);

const getChatInfoTool = tool(
  "telegram_get_chat_info",
  "Telegram chat/kullanıcı bilgilerini getirir.",
  {
    chatId: z.number().describe("Chat/kullanıcı ID"),
  },
  async ({ chatId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const chat = await telegramBot.api.getChat(chatId);

    return {
      id: chat.id,
      type: chat.type,
      title: "title" in chat ? chat.title : undefined,
      username: "username" in chat ? chat.username : undefined,
      firstName: "first_name" in chat ? chat.first_name : undefined,
      lastName: "last_name" in chat ? chat.last_name : undefined,
      bio: "bio" in chat ? chat.bio : undefined,
    };
  }
);

const sendMessageWithButtonsTool = tool(
  "telegram_send_message_with_buttons",
  "Telegram'dan inline butonlu mesaj gönderir.",
  {
    userId: z.number().describe("Alıcı kullanıcı ID"),
    text: z.string().describe("Mesaj metni"),
    buttons: z
      .array(
        z.array(
          z.object({
            text: z.string().describe("Buton metni"),
            url: z.string().optional().describe("Tıklanınca açılacak URL"),
            callbackData: z.string().optional().describe("Callback data"),
          })
        )
      )
      .describe("Buton satırları"),
  },
  async ({ userId, text, buttons }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const keyboard = buttons.map((row) =>
      row.map((btn) => {
        if (btn.url) {
          return { text: btn.text, url: btn.url };
        }
        if (btn.callbackData) {
          return { text: btn.text, callback_data: btn.callbackData };
        }
        return { text: btn.text, callback_data: btn.text };
      })
    );

    await telegramBot.api.sendMessage(userId, text, {
      reply_markup: {
        inline_keyboard: keyboard as any,
      },
    });

    return { success: true, message: "Butonlu mesaj gönderildi" };
  }
);

const setTypingTool = tool(
  "telegram_set_typing",
  "Telegram'da 'yazıyor...' göstergesi gösterir.",
  {
    userId: z.number().describe("Chat/kullanıcı ID"),
    action: z
      .enum(["typing", "upload_photo", "upload_video", "upload_document", "record_voice"])
      .optional()
      .describe("Aksiyon tipi"),
  },
  async ({ userId, action }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendChatAction(userId, action || "typing");

    return { success: true, message: "Chat action gönderildi" };
  }
);

// ============ MCP SERVER ============

/**
 * Get Telegram bot instance
 */
export function getTelegramBot(): Bot | null {
  return telegramBot;
}

export function createTelegramServer() {
  return createSdkMcpServer({
    name: "cobrain-telegram",
    version: "1.0.0",
    tools: [
      sendPhotoTool,
      sendDocumentTool,
      sendVoiceTool,
      sendVideoTool,
      sendLocationTool,
      sendStickerTool,
      sendAnimationTool,
      sendPollTool,
      editMessageTool,
      deleteMessageTool,
      pinMessageTool,
      unpinMessageTool,
      forwardMessageTool,
      getChatInfoTool,
      sendMessageWithButtonsTool,
      setTypingTool,
    ],
  });
}

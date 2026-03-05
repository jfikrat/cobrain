/**
 * Telegram MCP Server
 * Exposes Telegram bot capabilities to the agent
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { config } from "../../config.ts";
import {
  registerAgent,
  archiveAgent,
  getAgentById,
  updateAgentActivity,
  type AgentType,
} from "../../agents/registry.ts";
import { scaffoldAgentMindFiles } from "../../agents/templates/index.ts";
import { refreshTopicRoutes } from "../../channels/telegram-router.ts";
import { userManager } from "../../services/user-manager.ts";

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

// ============ PROACTIVE TOPIC MESSAGING ============

/**
 * Send a message to a Telegram forum topic (programmatic use).
 */
export async function sendToTopic(
  chatId: number,
  threadId: number,
  text: string,
  parseMode?: "HTML" | "Markdown",
): Promise<void> {
  if (!telegramBot) throw new Error("Telegram bot not initialized");
  await telegramBot.api.sendMessage(chatId, text, {
    message_thread_id: threadId,
    parse_mode: parseMode,
  });
}

const sendTopicMessageTool = tool(
  "telegram_send_topic_message",
  "Telegram forum topic'ine mesaj gönderir. Proaktif mesajlar için kullan.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    threadId: z.number().describe("Topic thread ID"),
    text: z.string().describe("Mesaj metni"),
    parseMode: z.enum(["HTML", "Markdown"]).optional().describe("Parse mode"),
  },
  async ({ chatId, threadId, text, parseMode }) => {
    await sendToTopic(chatId, threadId, text, parseMode);
    return { success: true, message: "Topic'e mesaj gönderildi" };
  },
);

// ============ FORUM TOPIC TOOLS ============

const createForumTopicTool = tool(
  "telegram_create_forum_topic",
  "Telegram supergroup'ta yeni forum topic oluşturur.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    name: z.string().describe("Topic adı"),
    iconColor: z.number().optional().describe("Icon rengi (0x-hex)"),
  },
  async ({ chatId, name, iconColor }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const result = await telegramBot.api.createForumTopic(chatId, name, {
      icon_color: iconColor as any,
    });

    return {
      success: true,
      topicId: result.message_thread_id,
      name: result.name,
    };
  }
);

const closeForumTopicTool = tool(
  "telegram_close_forum_topic",
  "Telegram forum topic'ini kapatır.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    threadId: z.number().describe("Topic thread ID"),
  },
  async ({ chatId, threadId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.closeForumTopic(chatId, threadId);

    return { success: true, message: "Topic kapatıldı" };
  }
);

const reopenForumTopicTool = tool(
  "telegram_reopen_forum_topic",
  "Kapatılmış forum topic'ini yeniden açar.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    threadId: z.number().describe("Topic thread ID"),
  },
  async ({ chatId, threadId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.reopenForumTopic(chatId, threadId);

    return { success: true, message: "Topic yeniden açıldı" };
  }
);

// ============ AGENT LIFECYCLE TOOLS ============

const agentCreateTool = tool(
  "agent_create",
  "Yeni agent oluşturur: forum topic + mind dosyaları + registry kaydı. Hub supergroup'ta çalışır.",
  {
    name: z.string().describe("Agent görünen adı (örn: 'Kod', 'Araştırma')"),
    type: z.enum(["genel", "whatsapp", "kod", "arastirma", "custom"]).describe("Agent tipi"),
    description: z.string().optional().describe("Agent açıklaması"),
    iconColor: z.number().optional().describe("Topic icon rengi"),
  },
  async ({ name, type, description, iconColor }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");
    if (!config.COBRAIN_HUB_ID) throw new Error("COBRAIN_HUB_ID not configured");

    const hubChatId = config.COBRAIN_HUB_ID;
    const agentId = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");

    // 1. Telegram forum topic oluştur
    const topic = await telegramBot.api.createForumTopic(hubChatId, name, {
      icon_color: iconColor as any,
    });

    // 2. Mind dosyalarını scaffold et
    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
    const mindDir = await scaffoldAgentMindFiles(userFolder, agentId, type as AgentType, name);

    // 3. Registry'ye kaydet
    const agent = await registerAgent({
      id: agentId,
      name,
      type: type as AgentType,
      topicId: topic.message_thread_id,
      mindDir,
      sharedMindFiles: ["contacts.md"],
      sessionKeyPrefix: `tg_agent_${agentId}`,
      status: "active",
      description,
    });

    // 4. Route'ları güncelle
    refreshTopicRoutes();

    return {
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        topicId: agent.topicId,
        mindDir: agent.mindDir,
      },
      message: `Agent "${name}" oluşturuldu (topic: ${topic.message_thread_id})`,
    };
  }
);

const agentArchiveTool = tool(
  "agent_archive",
  "Agent'ı arşivler: topic kapatır + registry'den archived yapar.",
  {
    agentId: z.string().describe("Agent ID (slug)"),
  },
  async ({ agentId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");
    if (!config.COBRAIN_HUB_ID) throw new Error("COBRAIN_HUB_ID not configured");

    const agent = getAgentById(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" bulunamadı`);

    // 1. Topic'i kapat
    try {
      await telegramBot.api.closeForumTopic(config.COBRAIN_HUB_ID, agent.topicId);
    } catch (err) {
      console.warn(`[AgentArchive] Topic kapatılamadı:`, err);
    }

    // 2. Registry'de archived yap
    await archiveAgent(agentId);

    // 3. Route'ları güncelle
    refreshTopicRoutes();

    return {
      success: true,
      message: `Agent "${agentId}" arşivlendi`,
    };
  }
);

// ============ CROSS-AGENT VISIBILITY ============

const agentGetHistoryTool = tool(
  "agent_get_history",
  "Bir agent'ın son etkileşimlerini getirir. Diğer agent'ların ne konuştuğunu görmek için kullan.",
  {
    agentId: z.string().describe("Agent ID (slug, örn: 'kod', 'arastirma')"),
    limit: z.number().optional().default(5).describe("Kaç etkileşim getirilsin"),
  },
  async ({ agentId, limit }) => {
    const { getAgentHistorySummary } = await import("../../agents/interaction-log.ts");
    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
    const summary = await getAgentHistorySummary(userFolder, agentId, limit);
    return { summary };
  },
);

// ============ DELEGATION ============

const agentDelegateTool = tool(
  "agent_delegate",
  "Başka bir agent'a mesaj delege eder. Hedef agent'ın session'ında çalıştırır, cevabı döndürür ve opsiyonel olarak topic'e yazar.",
  {
    agentId: z.string().describe("Hedef agent ID (slug, örn: 'kod', 'arastirma')"),
    message: z.string().describe("Agent'a gönderilecek mesaj"),
    postToTopic: z.boolean().optional().default(true).describe("Cevabı agent'ın topic'ine yaz"),
  },
  async ({ agentId, message, postToTopic }) => {
    const { buildRouteSystemPrompt } = await import("../../channels/telegram-router.ts");
    const { _executeChat: agentChat } = await import("../chat.ts");
    const { logAgentInteraction } = await import("../../agents/interaction-log.ts");
    const { sendToTopic: sendToTopicFn } = await import("./telegram.ts");

    const agent = getAgentById(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" bulunamadı`);
    if (agent.status !== "active") throw new Error(`Agent "${agentId}" aktif değil`);

    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);

    // Build system prompt from agent's mind files
    const systemPrompt = await buildRouteSystemPrompt(
      {
        name: agent.name,
        mindDir: agent.mindDir,
        sharedMindFiles: agent.sharedMindFiles,
        sessionKeyPrefix: agent.sessionKeyPrefix,
      },
      userFolder,
    );

    // Run in agent's isolated session
    const sessionKey = `${agent.sessionKeyPrefix}_delegated`;
    const response = await agentChat(config.MY_TELEGRAM_ID, message, undefined, undefined, 1, {
      systemPromptOverride: systemPrompt,
      sessionKey,
      channel: `telegram:hub:${agentId}:delegated`,
      silent: true,
    });

    // Log the interaction
    logAgentInteraction(userFolder, {
      timestamp: new Date().toISOString(),
      agentId,
      userMessage: `[Delegasyon] ${message}`,
      agentResponse: response.content,
      channel: `telegram:hub:${agentId}:delegated`,
      toolsUsed: response.toolsUsed,
      costUsd: response.totalCost,
    }).catch((err) => console.warn("[Delegate] Log failed:", err));

    // Post to agent's topic
    if (postToTopic && config.COBRAIN_HUB_ID && agent.topicId) {
      try {
        const topicMsg = `📨 <b>Delegasyon</b>\n\n<b>Soru:</b> ${message.slice(0, 200)}\n\n<b>Cevap:</b> ${response.content.slice(0, 3000)}`;
        await sendToTopicFn(config.COBRAIN_HUB_ID, agent.topicId, topicMsg, "HTML");
      } catch (err) {
        console.warn("[Delegate] Topic mesajı gönderilemedi:", err);
      }
    }

    updateAgentActivity(agentId);

    return {
      agentId,
      response: response.content,
      toolsUsed: response.toolsUsed,
      costUsd: response.totalCost,
    };
  },
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
      // Proactive topic messaging
      sendTopicMessageTool,
      // Forum tools
      createForumTopicTool,
      closeForumTopicTool,
      reopenForumTopicTool,
      // Agent lifecycle
      agentCreateTool,
      agentArchiveTool,
      // Cross-agent visibility + delegation
      agentGetHistoryTool,
      agentDelegateTool,
    ],
  });
}

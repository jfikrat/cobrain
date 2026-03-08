/**
 * Telegram MCP Server
 * Exposes Telegram bot capabilities to the agent
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { toolSuccess, toolError, toolJson } from "../../utils/tool-response.ts";
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
import { scaffoldAgentMindFiles } from "../../agents/seed/index.ts";
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
  "Send a photo to a Telegram user. Accepts a file path or URL.",
  {
    userId: z.number().describe("Recipient user ID"),
    photo: z.string().describe("Photo file path or URL"),
    caption: z.string().optional().describe("Photo caption"),
  },
  async ({ userId, photo, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const photoSource = photo.startsWith("http") ? photo : new InputFile(photo);

    await telegramBot.api.sendPhoto(userId, photoSource, { caption });

    return { success: true, message: "Photo sent" };
  }
);

const sendDocumentTool = tool(
  "telegram_send_document",
  "Send a file to a Telegram user.",
  {
    userId: z.number().describe("Recipient user ID"),
    document: z.string().describe("File path"),
    caption: z.string().optional().describe("File caption"),
    filename: z.string().optional().describe("Displayed filename"),
  },
  async ({ userId, document, caption, filename }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const file = new InputFile(document, filename);

    await telegramBot.api.sendDocument(userId, file, { caption });

    return { success: true, message: "File sent" };
  }
);

const sendVoiceTool = tool(
  "telegram_send_voice",
  "Send a voice message to a Telegram user (.ogg format).",
  {
    userId: z.number().describe("Recipient user ID"),
    voice: z.string().describe("Voice file path (.ogg)"),
    caption: z.string().optional().describe("Caption"),
  },
  async ({ userId, voice, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendVoice(userId, new InputFile(voice), { caption });

    return { success: true, message: "Voice message sent" };
  }
);

const sendVideoTool = tool(
  "telegram_send_video",
  "Send a video to a Telegram user.",
  {
    userId: z.number().describe("Recipient user ID"),
    video: z.string().describe("Video file path or URL"),
    caption: z.string().optional().describe("Video caption"),
  },
  async ({ userId, video, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const videoSource = video.startsWith("http") ? video : new InputFile(video);

    await telegramBot.api.sendVideo(userId, videoSource, { caption });

    return { success: true, message: "Video sent" };
  }
);

const sendLocationTool = tool(
  "telegram_send_location",
  "Send a location to a Telegram user.",
  {
    userId: z.number().describe("Recipient user ID"),
    latitude: z.number().describe("Enlem"),
    longitude: z.number().describe("Boylam"),
  },
  async ({ userId, latitude, longitude }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendLocation(userId, latitude, longitude);

    return { success: true, message: "Location sent" };
  }
);

const sendStickerTool = tool(
  "telegram_send_sticker",
  "Send a sticker to a Telegram user.",
  {
    userId: z.number().describe("Recipient user ID"),
    sticker: z.string().describe("Sticker file_id or URL"),
  },
  async ({ userId, sticker }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendSticker(userId, sticker);

    return { success: true, message: "Sticker sent" };
  }
);

const sendPollTool = tool(
  "telegram_send_poll",
  "Send a poll to a Telegram user.",
  {
    userId: z.number().describe("Recipient user ID"),
    question: z.string().describe("Poll question"),
    options: z.array(z.string()).describe("Options (at least 2)"),
    isAnonymous: z.boolean().optional().describe("Anonymous?"),
    allowsMultipleAnswers: z.boolean().optional().describe("Multiple answers?"),
  },
  async ({ userId, question, options, isAnonymous, allowsMultipleAnswers }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendPoll(userId, question, options, {
      is_anonymous: isAnonymous ?? true,
      allows_multiple_answers: allowsMultipleAnswers ?? false,
    });

    return { success: true, message: "Poll sent" };
  }
);

const editMessageTool = tool(
  "telegram_edit_message",
  "Edit a sent Telegram message.",
  {
    userId: z.number().describe("Chat/user ID"),
    messageId: z.number().describe("Message ID to edit"),
    text: z.string().describe("New message text"),
  },
  async ({ userId, messageId, text }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.editMessageText(userId, messageId, text);

    return { success: true, message: "Message edited" };
  }
);

const deleteMessageTool = tool(
  "telegram_delete_message",
  "Delete a Telegram message.",
  {
    userId: z.number().describe("Chat/user ID"),
    messageId: z.number().describe("Message ID to delete"),
  },
  async ({ userId, messageId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.deleteMessage(userId, messageId);

    return { success: true, message: "Message deleted" };
  }
);

const pinMessageTool = tool(
  "telegram_pin_message",
  "Pin a Telegram message.",
  {
    userId: z.number().describe("Chat/user ID"),
    messageId: z.number().describe("Message ID to pin"),
    disableNotification: z.boolean().optional().describe("Pin silently?"),
  },
  async ({ userId, messageId, disableNotification }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.pinChatMessage(userId, messageId, {
      disable_notification: disableNotification ?? false,
    });

    return { success: true, message: "Message pinned" };
  }
);

const unpinMessageTool = tool(
  "telegram_unpin_message",
  "Unpin a Telegram message. If messageId is omitted, all pins are removed.",
  {
    userId: z.number().describe("Chat/user ID"),
    messageId: z.number().optional().describe("Message ID (all if omitted)"),
  },
  async ({ userId, messageId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    if (messageId) {
      await telegramBot.api.unpinChatMessage(userId);
    } else {
      await telegramBot.api.unpinAllChatMessages(userId);
    }

    return { success: true, message: "Message unpinned" };
  }
);

const sendAnimationTool = tool(
  "telegram_send_animation",
  "Send a GIF/animation to a Telegram user.",
  {
    userId: z.number().describe("Recipient user ID"),
    animation: z.string().describe("GIF file path or URL"),
    caption: z.string().optional().describe("Caption"),
  },
  async ({ userId, animation, caption }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    const animSource = animation.startsWith("http") ? animation : new InputFile(animation);

    await telegramBot.api.sendAnimation(userId, animSource, { caption });

    return { success: true, message: "Animation sent" };
  }
);

const forwardMessageTool = tool(
  "telegram_forward_message",
  "Forward a Telegram message to another chat.",
  {
    toChatId: z.number().describe("Target chat ID"),
    fromChatId: z.number().describe("Source chat ID"),
    messageId: z.number().describe("Message ID to forward"),
  },
  async ({ toChatId, fromChatId, messageId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.forwardMessage(toChatId, fromChatId, messageId);

    return { success: true, message: "Message forwarded" };
  }
);

const getChatInfoTool = tool(
  "telegram_get_chat_info",
  "Get Telegram chat/user information.",
  {
    chatId: z.number().describe("Chat/user ID"),
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
  "Send a Telegram message with inline buttons.",
  {
    userId: z.number().describe("Recipient user ID"),
    text: z.string().describe("Message text"),
    buttons: z
      .array(
        z.array(
          z.object({
            text: z.string().describe("Button text"),
            url: z.string().optional().describe("URL to open when clicked"),
            callbackData: z.string().optional().describe("Callback data"),
          })
        )
      )
      .describe("Button rows"),
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

    return { success: true, message: "Message with buttons sent" };
  }
);

const setTypingTool = tool(
  "telegram_set_typing",
  "Show the Telegram 'typing...' indicator.",
  {
    userId: z.number().describe("Chat/user ID"),
    action: z
      .enum(["typing", "upload_photo", "upload_video", "upload_document", "record_voice"])
      .optional()
      .describe("Action type"),
  },
  async ({ userId, action }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.sendChatAction(userId, action || "typing");

    return { success: true, message: "Chat action sent" };
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
  "Send a message to a Telegram forum topic. Use for proactive messages.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    threadId: z.number().describe("Topic thread ID"),
    text: z.string().describe("Message text"),
    parseMode: z.enum(["HTML", "Markdown"]).optional().describe("Parse mode"),
  },
  async ({ chatId, threadId, text, parseMode }) => {
    await sendToTopic(chatId, threadId, text, parseMode);
    return { success: true, message: "Message sent to topic" };
  },
);

// ============ FORUM TOPIC TOOLS ============

const createForumTopicTool = tool(
  "telegram_create_forum_topic",
  "Create a new forum topic in a Telegram supergroup.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    name: z.string().describe("Topic name"),
    iconColor: z.number().optional().describe("Icon color (0x hex)"),
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
  "Close a Telegram forum topic.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    threadId: z.number().describe("Topic thread ID"),
  },
  async ({ chatId, threadId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.closeForumTopic(chatId, threadId);

    return { success: true, message: "Topic closed" };
  }
);

const reopenForumTopicTool = tool(
  "telegram_reopen_forum_topic",
  "Reopen a closed forum topic.",
  {
    chatId: z.number().describe("Supergroup chat ID"),
    threadId: z.number().describe("Topic thread ID"),
  },
  async ({ chatId, threadId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");

    await telegramBot.api.reopenForumTopic(chatId, threadId);

    return { success: true, message: "Topic reopened" };
  }
);

// ============ AGENT LIFECYCLE TOOLS ============

const agentCreateTool = tool(
  "agent_create",
  "Create a new agent: forum topic + mind files + registry entry. Works in the hub supergroup.",
  {
    name: z.string().describe("Agent display name (e.g. 'Code', 'Research')"),
    type: z.enum(["general", "whatsapp", "code", "research", "custom"]).describe("Agent type"),
    description: z.string().optional().describe("Agent description"),
    iconColor: z.number().optional().describe("Topic icon color"),
    workDir: z.string().optional().describe("Agent working directory (e.g. '/home/fjds/apps/finance-app')"),
  },
  async ({ name, type, description, iconColor, workDir }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");
    if (!config.COBRAIN_HUB_ID) throw new Error("COBRAIN_HUB_ID not configured");

    const hubChatId = config.COBRAIN_HUB_ID;
    const agentId = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");

    // Default workDir: ~/.cobrain/workspace/{agentId}
    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
    const resolvedWorkDir = workDir || `${userFolder}/workspace/${agentId}`;
    await import("node:fs/promises").then(fs => fs.mkdir(resolvedWorkDir, { recursive: true }));

    // 1. Create Telegram forum topic
    const topic = await telegramBot.api.createForumTopic(hubChatId, name, {
      icon_color: iconColor as any,
    });

    // 2. Scaffold mind files
    const mindDir = await scaffoldAgentMindFiles(userFolder, agentId, type as AgentType, name);

    // 3. Save to registry
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
      workDir: resolvedWorkDir,
    });

    // 4. Refresh routes
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
      message: `Agent "${name}" created (topic: ${topic.message_thread_id}). Mind files: identity.md, rules.md, behaviors.md, capabilities.md. BrainLoop will send heartbeat updates automatically.`,
    };
  }
);

const agentArchiveTool = tool(
  "agent_archive",
  "Archive an agent: close its topic and mark it archived in the registry.",
  {
    agentId: z.string().describe("Agent ID (slug)"),
  },
  async ({ agentId }) => {
    if (!telegramBot) throw new Error("Telegram bot not initialized");
    if (!config.COBRAIN_HUB_ID) throw new Error("COBRAIN_HUB_ID not configured");

    const agent = getAgentById(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);

    // 1. Close the topic
    try {
      await telegramBot.api.closeForumTopic(config.COBRAIN_HUB_ID, agent.topicId);
    } catch (err) {
      console.warn(`[AgentArchive] Failed to close topic:`, err);
    }

    // 2. Mark as archived in registry
    await archiveAgent(agentId);

    // 3. Refresh routes
    refreshTopicRoutes();

    return {
      success: true,
      message: `Agent "${agentId}" archived`,
    };
  }
);

// ============ CROSS-AGENT VISIBILITY ============

const agentGetHistoryTool = tool(
  "agent_get_history",
  "Get an agent's recent interactions. Use to see what other agents have been talking about.",
  {
    agentId: z.string().describe("Agent ID (slug, e.g. 'code', 'research')"),
    limit: z.number().optional().default(5).describe("Number of interactions to fetch"),
  },
  async ({ agentId, limit }) => {
    const { getAgentHistorySummary } = await import("../../agents/interaction-log.ts");
    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
    const summary = await getAgentHistorySummary(userFolder, agentId, limit);
    return toolSuccess(summary || `No interaction history yet for agent "${agentId}".`);
  },
);

// ============ DELEGATION ============

const agentDelegateTool = tool(
  "agent_delegate",
  "Delegate a message to another agent. Run it in the target agent's session, return the reply, and optionally post it to the topic.",
  {
    agentId: z.string().describe("Target agent ID (slug, e.g. 'code', 'research')"),
    message: z.string().describe("Message to send to the agent"),
    postToTopic: z.boolean().optional().default(true).describe("Post the reply to the agent's topic"),
  },
  async ({ agentId, message, postToTopic }) => {
    const { buildRouteSystemPrompt } = await import("../../channels/telegram-router.ts");
    const { _executeChat: agentChat } = await import("../chat.ts");
    const { logAgentInteraction } = await import("../../agents/interaction-log.ts");
    const { sendToTopic: sendToTopicFn } = await import("./telegram.ts");

    const agent = getAgentById(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    if (agent.status !== "active") throw new Error(`Agent "${agentId}" is not active`);

    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);

    // Build system prompt from agent's mind files
    const systemPrompt = await buildRouteSystemPrompt(
      {
        agentId: agent.id,
        name: agent.name,
        topicId: agent.topicId,
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
      userMessage: `[Delegation] ${message}`,
      agentResponse: response.content,
      channel: `telegram:hub:${agentId}:delegated`,
      toolsUsed: response.toolsUsed,
      costUsd: response.totalCost,
    }).catch((err) => console.warn("[Delegate] Log failed:", err));

    // Post to agent's topic
    if (postToTopic && config.COBRAIN_HUB_ID && agent.topicId) {
      try {
        const topicMsg = `📨 <b>Delegation</b>\n\n<b>Question:</b> ${message.slice(0, 200)}\n\n<b>Answer:</b> ${response.content.slice(0, 3000)}`;
        await sendToTopicFn(config.COBRAIN_HUB_ID, agent.topicId, topicMsg, "HTML");
      } catch (err) {
        console.warn("[Delegate] Failed to send topic message:", err);
      }
    }

    updateAgentActivity(agentId);

    return toolSuccess(`[${agent.name}]\n${response.content}`);
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

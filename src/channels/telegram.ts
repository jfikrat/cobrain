import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import { config } from "../config.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { think, clearSession, userManager } from "../brain/index.ts";
import { initPermissions, clearAllPending } from "../agent/permissions.ts";
import { initTelegramMcp } from "../agent/tools/telegram.ts";
import { UserMemory } from "../memory/sqlite.ts";
import { parseSuggestions, buildSuggestionKeyboard, type TelegramContext, type LiveLocationEntry } from "./telegram-helpers.ts";
import { registerCommands } from "./telegram-commands.ts";
import { registerCallbacks } from "./telegram-callbacks.ts";
import { registerMessageHandlers } from "./telegram-messages.ts";


const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Shared mutable state
const telegramCtx: TelegramContext = {
  liveLocationCache: new Map(),
};

export function getLiveLocation(userId: number): LiveLocationEntry | null {
  return telegramCtx.liveLocationCache.get(userId) ?? null;
}

// Initialize Telegram MCP with bot instance
initTelegramMcp(bot);

// Register all handlers
registerCommands(bot, telegramCtx);
registerCallbacks(bot, telegramCtx);
registerMessageHandlers(bot, telegramCtx);

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Heartbeat interval reference
let telegramHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

// ============ LIFECYCLE ============

export async function startBot(): Promise<void> {
  console.log("Starting Telegram bot...");

  // Initialize permission system for tool approvals via Telegram
  initPermissions(bot);
  console.log(`[Bot] Permission mode: ${config.PERMISSION_MODE}`);

  // Register slash command menu (localized)
  const { t } = await import("../i18n/index.ts");
  await bot.api.setMyCommands([
    { command: "start", description: t("menu.start") },
    { command: "help", description: t("menu.help") },
    { command: "status", description: t("menu.status") },
    { command: "clear", description: t("menu.clear") },
    { command: "restart", description: t("menu.restart") },
    { command: "web", description: t("menu.web") },
    { command: "mode", description: t("menu.mode") },
    { command: "lang", description: t("menu.lang") },
  ]);

  // Heartbeat: bot started
  heartbeat("telegram_bot", { event: "started" });

  // Periodic heartbeat for telegram bot
  telegramHeartbeatInterval = setInterval(() => {
    heartbeat("telegram_bot", { event: "tick" });
  }, 10_000);

  // Use Grammy Runner for concurrent processing
  const runner = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "edited_message", "callback_query", "inline_query"],
      },
    },
  });

  // Get and log bot info
  const botInfo = await bot.api.getMe();
  console.log(`Bot started: @${botInfo.username}`);

  // Startup notification
  const userId = config.MY_TELEGRAM_ID;
  console.log(`[Startup] Sending restart notification to user ${userId}`);
  clearSession(userId)
    .then(() => getStartupContext(userId))
    .then((contextSummary) => {
      const contextPart = contextSummary ? `\n\nLast conversation summary:\n${contextSummary}` : "";
      const startupMsg = `[SYSTEM] Bot restarted.${contextPart}\n\nIMPORTANT: This is a startup message. DO NOT RUN cobrain-restart or any restart command.\n\nNow do the following in order:\n1. Call recall("all") - load your memory\n2. Send a short summary to Telegram (max 5 lines): say you're back and list any important pending items`;
      return think(userId, startupMsg);
    })
    .then((response) => {
      console.log(`[Startup] Agent response: ${response.content.slice(0, 50)}...`);
      const { text: startupText, suggestions: startupSuggestions } = parseSuggestions(response.content);
      const startupKeyboard = buildSuggestionKeyboard(startupSuggestions);
      bot.api.sendMessage(userId, startupText, {
        ...(startupKeyboard && { reply_markup: startupKeyboard }),
      })
        .then(() => console.log(`[Startup] Message sent`))
        .catch((err: unknown) => console.error(`[Startup] Failed to send message:`, err));
    })
    .catch((err: unknown) => console.error(`[Startup] Agent error:`, err));

  // Graceful shutdown
  const stopRunner = () => runner.isRunning() && runner.stop();
  process.once("SIGINT", stopRunner);
  process.once("SIGTERM", stopRunner);
}

async function getStartupContext(userId: number): Promise<string | null> {
  try {
    const userDb = await userManager.getUserDb(userId);
    const memory = new UserMemory(userDb);
    const history = memory.getHistory(6);
    if (history.length === 0) return null;

    return history
      .filter((m) => !m.content.toLowerCase().includes("cobrain-restart"))
      .map((m) => `${m.role === "user" ? "User" : "Cobrain"}: ${m.content.slice(0, 150)}`)
      .join("\n");
  } catch {
    return null;
  }
}

export function stopBot(): Promise<void> {
  console.log("Stopping bot...");
  clearAllPending();
  if (telegramHeartbeatInterval) {
    clearInterval(telegramHeartbeatInterval);
    telegramHeartbeatInterval = null;
  }
  return bot.stop();
}

export { bot };

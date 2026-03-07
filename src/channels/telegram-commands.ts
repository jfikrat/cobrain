import type { Bot } from "grammy";
import { config } from "../config.ts";
import { clearSession, getStats, userManager, isVectorMemoryAvailable } from "../brain/index.ts";
import { generateSessionToken } from "../web/auth.ts";
import { isAuthorized, type TelegramContext } from "./telegram-helpers.ts";
import { t } from "../i18n/index.ts";
import { setLocale, getLocale, LOCALE_LABELS, type Locale } from "../i18n/index.ts";

export function registerCommands(bot: Bot, _ctx: TelegramContext) {
  bot.command("start", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) {
      await c.reply(t("cmd.unauthorized"));
      return;
    }
    await c.reply(t("cmd.start"), { parse_mode: "HTML" });
  });

  bot.command("help", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;
    await c.reply(t("cmd.help"), { parse_mode: "HTML" });
  });

  bot.command("status", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;
    const userId = c.from?.id ?? 0;
    const userStats = await getStats(userId);
    const ollamaAvailable = await isVectorMemoryAvailable();

    await c.reply(
      `${t("cmd.status_title")}\n\n` +
      `<b>Bot:</b> ${t("cmd.active")}\n` +
      `<b>AI:</b> Claude CLI (session-based)\n` +
      `<b>Base:</b> <code>${config.COBRAIN_BASE_PATH}</code>\n\n` +
      `<b>${t("cmd.smart_memory")}:</b> ${ollamaAvailable ? `${t("cmd.active")} (Cerebras)` : t("cmd.disabled")}\n` +
      `${!ollamaAvailable ? "<i>CEREBRAS_API_KEY not set</i>\n" : ""}` +
      `<b>${t("cmd.your_stats")}:</b>\n` +
      `• ${t("cmd.messages")}: ${userStats.messageCount}\n` +
      `• ${t("cmd.sessions")}: ${userStats.sessionCount}\n` +
      `• ${t("cmd.memories")}: ${userStats.memoryCount}\n` +
      `• ${t("cmd.total_cost")}: $${userStats.totalCost.toFixed(4)}\n\n` +
      `<b>Runtime:</b> Bun ${Bun.version}`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("clear", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;
    const userId = c.from?.id ?? 0;
    await clearSession(userId);
    if (config.FF_SESSION_STATE) {
      const { saveSessionState, DEFAULT_SESSION_STATE } = await import("../services/session-state.ts");
      saveSessionState(userId, { ...DEFAULT_SESSION_STATE });
    }
    await c.reply(t("cmd.cleared"));
  });

  bot.command("phase", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;
    const userId = c.from?.id ?? 0;
    if (!config.FF_SESSION_STATE) {
      await c.reply(t("cmd.session_state_disabled"));
      return;
    }
    const { getSessionState, updateSessionState } = await import("../services/session-state.ts");
    const args = c.message?.text?.split(" ").slice(1) || [];

    if (args.length === 0) {
      const state = getSessionState(userId);
      const phaseEmoji: Record<string, string> = {
        exploring: "🔍", decided: "✅", implementing: "🔨", deployed: "🚀", archived: "📦",
      };
      let text = `📊 <b>Session State</b>\n\n`;
      text += `<b>Phase:</b> ${phaseEmoji[state.conversationPhase] || ""} ${state.conversationPhase}\n`;
      text += `<b>Topic:</b> ${state.lastTopic || t("cmd.no_topic")}\n`;
      text += `<b>Confidence:</b> ${(state.confidence * 100).toFixed(0)}%\n`;
      text += `<b>Last message:</b> ${state.lastUserMessage ? state.lastUserMessage.slice(0, 80) + "..." : t("cmd.no_topic")}\n`;
      if (state.pendingActions.length > 0) {
        text += `\n<b>Pending actions:</b>\n`;
        for (const action of state.pendingActions) text += `• ${action}\n`;
      }
      text += `\n<i>Override: /phase exploring|decided|implementing|deployed|archived</i>`;
      await c.reply(text, { parse_mode: "HTML" });
    } else {
      const validPhases = ["exploring", "decided", "implementing", "deployed", "archived"];
      const newPhase = args[0]!.toLowerCase();
      if (!validPhases.includes(newPhase)) {
        await c.reply(t("cmd.invalid_phase", { phases: validPhases.join(", ") }));
        return;
      }
      updateSessionState(userId, { conversationPhase: newPhase as any, confidence: 1.0 });
      await c.reply(t("cmd.phase_updated", { phase: newPhase }));
    }
  });

  bot.command("restart", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;
    await c.reply(t("cmd.restarting"));
    setTimeout(() => process.exit(0), 500);
  });

  bot.command("web", async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;
    if (!config.ENABLE_WEB_UI) {
      await c.reply(t("cmd.web_disabled"));
      return;
    }
    try {
      const token = generateSessionToken(userId);
      const url = `${config.WEB_URL}?token=${token}`;
      await c.reply(
        `${t("cmd.web_title")}\n\n${t("cmd.web_link_valid")}\n<code>${url}</code>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: t("cmd.web_open"), url }]] },
        }
      );
    } catch (error) {
      await c.reply(t("cmd.error", { message: error instanceof Error ? error.message : "Unknown" }));
    }
  });

  bot.command("mode", async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;
    try {
      const settings = await userManager.getUserSettings(userId);
      const currentMode = settings.permissionMode || config.PERMISSION_MODE;
      const modeLabel = t(`mode.${currentMode}`);
      await c.reply(
        `⚙️ *Permission Mode*\n\n${t("mode.current")}: *${modeLabel}*\n\n${t("mode.select")}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: currentMode === "strict" ? "✓ Strict" : "Strict", callback_data: "mode:strict" },
              { text: currentMode === "smart" ? "✓ Smart" : "Smart", callback_data: "mode:smart" },
              { text: currentMode === "yolo" ? "✓ YOLO" : "YOLO", callback_data: "mode:yolo" },
            ]],
          },
        }
      );
    } catch (error) {
      await c.reply(t("cmd.error", { message: error instanceof Error ? error.message : "Unknown" }));
    }
  });

  // Handle mode change callbacks
  bot.callbackQuery(/^mode:(strict|smart|yolo)$/, async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;
    const mode = c.match![1] as "strict" | "smart" | "yolo";
    try {
      await userManager.updateUserSettings(userId, { permissionMode: mode });
      const modeLabel = t(`mode.${mode}`);
      await c.editMessageText(
        `⚙️ *Permission Mode*\n\n${t("mode.changed", { mode: modeLabel })}`,
        { parse_mode: "Markdown" }
      );
      await c.answerCallbackQuery(t("mode.updated"));
    } catch {
      await c.answerCallbackQuery(t("mode.error"));
    }
  });

  // ── /lang command ──
  bot.command("lang", async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;

    const current = getLocale();
    const currentLabel = LOCALE_LABELS[current];

    await c.reply(
      `${t("lang.current", { lang: currentLabel })}\n\n${t("lang.select")}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: current === "en" ? "✓ English" : "English", callback_data: "lang:en" },
            { text: current === "tr" ? "✓ Türkçe" : "Türkçe", callback_data: "lang:tr" },
          ]],
        },
      }
    );
  });

  // Handle language change callbacks
  bot.callbackQuery(/^lang:(en|tr)$/, async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;

    const locale = c.match![1] as Locale;
    setLocale(locale);
    await userManager.updateUserSettings(userId, { language: locale });

    const label = LOCALE_LABELS[locale];

    // Re-register command menu in new language
    await bot.api.setMyCommands([
      { command: "start", description: t("menu.start") },
      { command: "help", description: t("menu.help") },
      { command: "status", description: t("menu.status") },
      { command: "clear", description: t("menu.clear") },
      { command: "restart", description: t("menu.restart") },
      { command: "web", description: t("menu.web") },
      { command: "mode", description: t("menu.mode") },
      { command: "phase", description: t("menu.phase") },
      { command: "lang", description: t("menu.lang") },
    ]).catch(() => {});

    await c.editMessageText(
      t("lang.changed", { lang: label }),
      { parse_mode: "Markdown" }
    );
    await c.answerCallbackQuery(t("lang.updated"));
  });
}

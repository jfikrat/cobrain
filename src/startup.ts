/**
 * Normal Mode Startup
 * All service initialization when config is valid
 */

import { startBot, stopBot, bot } from "./channels/telegram.ts";
import { closeAll } from "./brain/index.ts";
import { config } from "./config.ts";
import { brainLoop } from "./services/brain-loop.ts";
import { expectations } from "./services/expectations.ts";
import {
  heartbeat,
  registerHeartbeatComponent,
  startHeartbeatMonitor,
  stopHeartbeatMonitor,
} from "./services/heartbeat.ts";
import { startWebServer, stopWebServer } from "./web/server.ts";
import { initEventStore } from "./brain/event-store.ts";
import { startProjectionScheduler, stopProjectionScheduler } from "./brain/projections.ts";
import { userManager } from "./services/user-manager.ts";

import { initInbox } from "./services/inbox.ts";
import { loadRegistry } from "./agents/registry.ts";
import { initTopicRoutes } from "./channels/telegram-router.ts";
import { setLocale } from "./i18n/index.ts";
import type { Locale } from "./i18n/index.ts";

console.log(`
   ██████╗ ██████╗ ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██║     ██║   ██║██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██║     ██║   ██║██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║██║██║ ╚████║
   ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝

  Personal AI Assistant v0.5.0
  Base: ${config.COBRAIN_BASE_PATH}
  Mode: Agent SDK
  Autonomous: ${config.ENABLE_AUTONOMOUS ? "Enabled" : "Disabled"}
  Web UI: ${config.ENABLE_WEB_UI ? `Enabled (port ${config.WEB_PORT})` : "Disabled"}
`);

// Phase 1: Event Brain — initialize event store on global DB
if (config.FF_BRAIN_EVENTS) {
  const globalDb = userManager.getGlobalDb();
  initEventStore(globalDb);
  startProjectionScheduler();
}

// Initialize services
registerHeartbeatComponent("app", { required: true });
registerHeartbeatComponent("ai_agent", { required: true });
registerHeartbeatComponent("telegram_bot", { required: true });
registerHeartbeatComponent("web_server", { required: config.ENABLE_WEB_UI });
registerHeartbeatComponent("brain_loop", { required: config.ENABLE_AUTONOMOUS });

heartbeat("app", { event: "startup" });
startHeartbeatMonitor();

const appHeartbeatInterval = setInterval(() => {
  heartbeat("app", { event: "tick", uptimeSec: Math.round(process.uptime()) });
}, Math.max(10_000, Math.floor(config.HEARTBEAT_STALE_AFTER_MS / 3)));

const aiAgentHeartbeatInterval = setInterval(() => {
  heartbeat("ai_agent", { event: "tick" });
}, Math.max(10_000, Math.floor(config.HEARTBEAT_STALE_AFTER_MS / 3)));

// Initialize locale from user settings
{
  const settings = await userManager.getUserSettings(config.MY_TELEGRAM_ID);
  const locale = (settings.language || "en") as Locale;
  setLocale(locale);
  console.log(`[Startup] Locale: ${locale}`);
}

// Load agent registry + topic routes (before bot starts, so topic routes are ready)
if (config.COBRAIN_HUB_ID) {
  const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
  await loadRegistry(userFolder);
  initTopicRoutes();
  console.log("[Startup] Agent registry loaded, topic routes initialized");
}

// Start Telegram bot
startBot();

// Start Web Server
if (config.ENABLE_WEB_UI) {
  startWebServer();
}

// Initialize proactive features after bot starts
if (config.ENABLE_AUTONOMOUS) {
  // Wait a bit for bot to be ready
  setTimeout(async () => {
    // Load expectations
    await expectations.load();

    // Load inbox
    const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
    await initInbox(userFolder);

    // Start periodic expectation cleanup
    setInterval(() => {
      expectations.cleanExpired();
    }, config.CORTEX_EXPECTATION_CLEANUP_INTERVAL_MS);

    // Start BrainLoop (events routed directly to Cortex)
    brainLoop.start(bot);
    console.log("[Startup] BrainLoop started");

    // WA Agent now runs through the hub — no standalone process needed
    // BrainLoop checks pending messages every 5min via checkWAMessages()
  }, 1000);
}

const shutdown = async () => {
  console.log("\nShutting down...");

  await brainLoop.stop();
  stopProjectionScheduler();

  if (config.ENABLE_WEB_UI) {
    stopWebServer();
  }

  clearInterval(appHeartbeatInterval);
  clearInterval(aiAgentHeartbeatInterval);
  stopHeartbeatMonitor();

  await stopBot();
  await closeAll();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

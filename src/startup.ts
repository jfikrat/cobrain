/**
 * Normal Mode Startup
 * All service initialization when config is valid
 */

import { startBot, stopBot, bot } from "./channels/telegram.ts";
import { closeAll } from "./brain/index.ts";
import { config } from "./config.ts";
import { initProactive, stopProactive } from "./services/proactive.ts";
import { initScheduler } from "./services/scheduler.ts";
import { initTaskQueue } from "./services/task-queue.ts";
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

console.log(`
   ██████╗ ██████╗ ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██║     ██║   ██║██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██║     ██║   ██║██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║██║██║ ╚████║
   ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝

  Kişisel AI Asistan v0.4.0
  Base: ${config.COBRAIN_BASE_PATH}
  Mode: ${config.USE_AGENT_SDK ? "Agent SDK" : "CLI (tmux)"}
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
registerHeartbeatComponent("scheduler", { required: config.ENABLE_AUTONOMOUS });
registerHeartbeatComponent("task_queue", { required: config.ENABLE_AUTONOMOUS });
registerHeartbeatComponent("proactive_service", { required: config.ENABLE_AUTONOMOUS });

heartbeat("app", { event: "startup" });
startHeartbeatMonitor();

const appHeartbeatInterval = setInterval(() => {
  heartbeat("app", { event: "tick", uptimeSec: Math.round(process.uptime()) });
}, Math.max(10_000, Math.floor(config.HEARTBEAT_STALE_AFTER_MS / 3)));

if (config.ENABLE_AUTONOMOUS) {
  initScheduler({ enabled: true });
  initTaskQueue({ enabled: true });
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
  setTimeout(() => {
    initProactive(bot);
    console.log("[Autonomous] Proactive features enabled");
  }, 1000);
}

const shutdown = async () => {
  console.log("\nKapatılıyor...");

  stopProjectionScheduler();

  if (config.ENABLE_AUTONOMOUS) {
    stopProactive();
  }

  if (config.ENABLE_WEB_UI) {
    stopWebServer();
  }

  clearInterval(appHeartbeatInterval);
  stopHeartbeatMonitor();

  await stopBot();
  await closeAll();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

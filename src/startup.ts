/**
 * Normal Mode Startup
 * All service initialization when config is valid
 */

import { startBot, stopBot, bot } from "./channels/telegram.ts";
import { closeAll } from "./brain/index.ts";
import { config } from "./config.ts";
import { initProactiveInfra, stopProactiveInfra } from "./services/proactive.ts";
import { brainLoop } from "./services/brain-loop.ts";
import { initScheduler } from "./services/scheduler.ts";
import { initTaskQueue } from "./services/task-queue.ts";
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
import { join } from "node:path";

// Sentinel
import { Sentinel } from "./sentinel/sentinel.ts";

console.log(`
   ██████╗ ██████╗ ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██║     ██║   ██║██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██║     ██║   ██║██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║██║██║ ╚████║
   ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝

  Kişisel AI Asistan v0.5.0 — Sentinel Edition
  Base: ${config.COBRAIN_BASE_PATH}
  Mode: ${config.USE_AGENT_SDK ? "Agent SDK" : "CLI (tmux)"}
  Autonomous: ${config.ENABLE_AUTONOMOUS ? "Enabled" : "Disabled"}
  Sentinel: ${config.FF_SENTINEL ? `Enabled (${config.SENTINEL_MODEL})` : "Disabled"}
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
registerHeartbeatComponent("scheduler", { required: config.ENABLE_AUTONOMOUS && !config.MINIMAL_AUTONOMY });
registerHeartbeatComponent("task_queue", { required: config.ENABLE_AUTONOMOUS && !config.MINIMAL_AUTONOMY });
registerHeartbeatComponent("brain_loop", { required: config.ENABLE_AUTONOMOUS });

heartbeat("app", { event: "startup" });
startHeartbeatMonitor();

const appHeartbeatInterval = setInterval(() => {
  heartbeat("app", { event: "tick", uptimeSec: Math.round(process.uptime()) });
}, Math.max(10_000, Math.floor(config.HEARTBEAT_STALE_AFTER_MS / 3)));

const aiAgentHeartbeatInterval = setInterval(() => {
  heartbeat("ai_agent", { event: "tick" });
}, Math.max(10_000, Math.floor(config.HEARTBEAT_STALE_AFTER_MS / 3)));

if (config.ENABLE_AUTONOMOUS && !config.MINIMAL_AUTONOMY) {
  initScheduler({ enabled: true });
  initTaskQueue({ enabled: true });
}

// Start Telegram bot
startBot();

// Start Web Server
if (config.ENABLE_WEB_UI) {
  startWebServer();
}

// Sentinel instance (created outside setTimeout so it's available for shutdown)
let sentinel: Sentinel | null = null;

// Initialize proactive features after bot starts
if (config.ENABLE_AUTONOMOUS) {
  // Wait a bit for bot to be ready
  setTimeout(async () => {
    // Load expectations
    await expectations.load();

    // Start periodic expectation cleanup
    setInterval(() => {
      expectations.cleanExpired();
    }, config.CORTEX_EXPECTATION_CLEANUP_INTERVAL_MS);

    if (!config.MINIMAL_AUTONOMY) {
      initProactiveInfra(bot);
      console.log("[Autonomous] Proactive infrastructure enabled");
    } else {
      console.log("[Autonomous] Minimal autonomy mode: proactive infra disabled");
    }

    // Create and start Sentinel
    if (config.FF_SENTINEL) {
      const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
      sentinel = new Sentinel({
        model: config.SENTINEL_MODEL,
        notebookPath: join(userFolder, "sentinel-notebook.md"),
        maxTurns: config.SENTINEL_MAX_TURNS,
        consolidationThreshold: config.SENTINEL_CONSOLIDATION_THRESHOLD,
        maxWakesPerHour: config.SENTINEL_MAX_WAKES_PER_HOUR,
        userId: config.MY_TELEGRAM_ID,
      });
      await sentinel.start(bot);
      console.log("[Startup] Sentinel started");
    }

    // Start BrainLoop with sentinel
    brainLoop.start(bot, sentinel!);
    console.log("[Startup] BrainLoop started");
  }, 1000);
}

const shutdown = async () => {
  console.log("\nKapatılıyor...");

  await brainLoop.stop();
  if (sentinel) {
    await sentinel.stop();
  }
  stopProjectionScheduler();

  if (config.ENABLE_AUTONOMOUS && !config.MINIMAL_AUTONOMY) {
    stopProactiveInfra();
  }

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

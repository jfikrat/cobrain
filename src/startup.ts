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

import { initInbox } from "./services/inbox.ts";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { loadRegistry, getAgentById } from "./agents/registry.ts";
import { initTopicRoutes } from "./channels/telegram-router.ts";

let waAgentProc: Subprocess | null = null;

console.log(`
   ██████╗ ██████╗ ██████╗ ██████╗  █████╗ ██╗███╗   ██╗
  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║
  ██║     ██║   ██║██████╔╝██████╔╝███████║██║██╔██╗ ██║
  ██║     ██║   ██║██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║
  ╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║██║██║ ╚████║
   ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝

  Kişisel AI Asistan v0.5.0
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

    if (!config.MINIMAL_AUTONOMY) {
      initProactiveInfra(bot);
      console.log("[Autonomous] Proactive infrastructure enabled");
    } else {
      console.log("[Autonomous] Minimal autonomy mode: proactive infra disabled");
    }

    // Start BrainLoop (events routed directly to Cortex)
    brainLoop.start(bot);
    console.log("[Startup] BrainLoop started");

    // Start WA Agent (standalone process)
    if (config.WA_AGENT_ENABLED) {
      // Auto-discover WA agent topic ID from registry
      const waTopicId = config.COBRAIN_HUB_ID
        ? getAgentById("whatsapp")?.topicId
        : undefined;

      const waAgentPath = resolve(import.meta.dir, "agents/wa/index.ts");
      waAgentProc = Bun.spawn(["bun", "run", waAgentPath], {
        env: {
          ...process.env,
          WA_AGENT_PORT: String(config.WA_AGENT_PORT),
          ...(config.COBRAIN_HUB_ID ? { COBRAIN_HUB_ID: String(config.COBRAIN_HUB_ID) } : {}),
          ...(waTopicId ? { WA_AGENT_TOPIC_ID: String(waTopicId) } : {}),
        },
        stdout: "inherit",
        stderr: "inherit",
        onExit(proc, code) {
          console.warn(`[WA Agent] Process çıktı (code: ${code})`);
          waAgentProc = null;
        },
      });
      console.log(`[Startup] WA Agent started (pid: ${waAgentProc.pid}, port: ${config.WA_AGENT_PORT})`);
    }
  }, 1000);
}

const shutdown = async () => {
  console.log("\nKapatılıyor...");

  // Kill WA Agent child process
  if (waAgentProc) {
    console.log(`[Shutdown] WA Agent kapatılıyor (pid: ${waAgentProc.pid})...`);
    waAgentProc.kill();
    waAgentProc = null;
  }

  await brainLoop.stop();
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

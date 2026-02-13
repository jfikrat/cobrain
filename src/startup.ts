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
import { cortex, actionExecutor } from "./cortex/index.ts";
import type { ActionType } from "./cortex/reasoner.ts";
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
  setTimeout(async () => {
    // Register Cortex action handlers
    actionExecutor.register("send_message" as ActionType, async (params) => {
      const text = params.text as string || params.message as string || "Bildirim";
      try {
        await bot.api.sendMessage(config.MY_TELEGRAM_ID, text);
        return { success: true, action: "send_message" as ActionType, message: `Sent: ${text.slice(0, 50)}` };
      } catch (err) {
        return { success: false, action: "send_message" as ActionType, message: `Failed: ${err}` };
      }
    });

    actionExecutor.register("send_whatsapp" as ActionType, async (params) => {
      const to = params.to as string || "";
      const message = params.message as string || "";
      if (!to || !message) {
        return { success: false, action: "send_whatsapp" as ActionType, message: "Missing to or message" };
      }
      const { wasRecentlyReplied } = await import("./services/reply-dedup.ts");
      if (wasRecentlyReplied(to)) {
        console.log(`[Cortex:Action] send_whatsapp skipped for ${to} — already replied by proactive`);
        return { success: true, action: "send_whatsapp" as ActionType, message: "Skipped: proactive already replied" };
      }
      try {
        const { whatsappDB } = await import("./services/whatsapp-db.ts");
        const outboxId = whatsappDB.sendMessage(to, message);
        return { success: true, action: "send_whatsapp" as ActionType, message: `Queued: #${outboxId}` };
      } catch (err) {
        return { success: false, action: "send_whatsapp" as ActionType, message: `Failed: ${err}` };
      }
    });

    actionExecutor.register("calculate_route" as ActionType, async (params) => {
      // Route hesaplama — şimdilik sadece log, ileride location MCP'ye bağlanacak
      const from = params.from as string || params.origin as string || "";
      const to = params.to as string || params.destination as string || "";
      console.log(`[Cortex:Action] Route requested: ${from} → ${to}`);
      return { success: true, action: "calculate_route" as ActionType, message: `Route: ${from} → ${to}`, data: { from, to } };
    });

    actionExecutor.register("check_whatsapp" as ActionType, async (params) => {
      const chatJid = params.chatJid as string || params.target as string || "";
      try {
        const { whatsappDB } = await import("./services/whatsapp-db.ts");
        const messages = whatsappDB.getMessages(chatJid, 5);
        const summary = messages.map(m => `${m.sender_jid || "?"}: ${m.content?.slice(0, 100) || "[media]"}`).join("\n");
        console.log(`[Cortex:Action] WhatsApp check: ${chatJid} — ${messages.length} messages`);
        return { success: true, action: "check_whatsapp" as ActionType, message: summary || "No messages found", data: { chatJid, count: messages.length } };
      } catch (err) {
        return { success: false, action: "check_whatsapp" as ActionType, message: `Failed: ${err}` };
      }
    });

    actionExecutor.register("remember" as ActionType, async (params) => {
      const content = params.content as string || params.text as string || "";
      console.log(`[Cortex:Action] Remember: ${content.slice(0, 100)}`);
      // Hafızaya kaydetme şimdilik sadece log — MCP memory tool'a bağlanacak
      return { success: true, action: "remember" as ActionType, message: `Noted: ${content.slice(0, 50)}` };
    });

    // Start Cortex — sinir ağı pipeline
    await cortex.start({
      userContextProvider: async (userId) => {
        // Basit context: kullanıcı bilgisi
        return `Kullanıcı: Fekrat (Yazılım Geliştirici). Zaman: ${new Date().toLocaleString("tr-TR")}`;
      },
      onActionExecuted: (signal, result) => {
        console.log(`[Cortex] Action result: ${result.action} success=${result.success} ${result.message || ""}`);
      },
      onError: (error, signal) => {
        console.error(`[Cortex] Error processing ${signal.source}/${signal.type}:`, error.message);
      },
    });

    initProactive(bot);
    console.log("[Autonomous] Proactive features enabled");
  }, 1000);
}

const shutdown = async () => {
  console.log("\nKapatılıyor...");

  cortex.stop();
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

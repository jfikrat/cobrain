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
registerHeartbeatComponent("cortex", { required: config.ENABLE_AUTONOMOUS });

heartbeat("app", { event: "startup" });
startHeartbeatMonitor();

let cortexHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

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
      const { wasRecentlyReplied, markReplied } = await import("./services/reply-dedup.ts");
      if (wasRecentlyReplied(to)) {
        console.log(`[Cortex:Action] send_whatsapp skipped for ${to} — already replied by proactive`);
        return { success: true, action: "send_whatsapp" as ActionType, message: "Skipped: proactive already replied" };
      }
      try {
        const { whatsappDB } = await import("./services/whatsapp-db.ts");
        const outboxId = whatsappDB.sendMessage(to, message);
        // Mark as replied AFTER successful outbox write to prevent proactive from also replying
        markReplied(to);

        // Create expectation for reply tracking (skip if one already exists for this target)
        const { expectations } = await import("./cortex/expectations.ts");
        const existing = expectations.pending().find(e => e.target === to && e.type === "whatsapp_reply");
        if (!existing) {
          expectations.create({
            type: "whatsapp_reply",
            target: to,
            context: `Cortex sent WhatsApp to ${to}: "${message.slice(0, 100)}"`,
            onResolved: "Reply received to Cortex-initiated message",
            userId: config.MY_TELEGRAM_ID,
            timeout: config.CORTEX_EXPECTATION_TIMEOUT_MS,
          });
        }

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
      if (!chatJid) {
        return { success: false, action: "check_whatsapp" as ActionType, message: "Missing chatJid or target" };
      }

      try {
        const { whatsappDB } = await import("./services/whatsapp-db.ts");
        if (!whatsappDB.isAvailable()) {
          return { success: false, action: "check_whatsapp" as ActionType, message: "WhatsApp DB unavailable" };
        }

        const limit = typeof params.limit === "number" ? params.limit : 5;
        const messages = whatsappDB.getMessages(chatJid, limit);

        if (messages.length === 0) {
          return { success: true, action: "check_whatsapp" as ActionType, message: "No messages found", data: { chatJid, count: 0 } };
        }

        const summary = messages.map(m => {
          const sender = m.is_from_me ? "Ben" : (m.sender_jid?.split("@")[0] || "?");
          const time = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "";
          return `[${time}] ${sender}: ${m.content?.slice(0, 100) || "[media]"}`;
        }).join("\n");

        console.log(`[Cortex:Action] WhatsApp check: ${chatJid} — ${messages.length} messages`);

        // Notify via Telegram if requested
        if (params.notify) {
          const chatName = chatJid.split("@")[0];
          await bot.api.sendMessage(config.MY_TELEGRAM_ID, `📱 WhatsApp (${chatName}):\n${summary.slice(0, 500)}`);
        }

        return { success: true, action: "check_whatsapp" as ActionType, message: summary, data: { chatJid, count: messages.length } };
      } catch (err) {
        return { success: false, action: "check_whatsapp" as ActionType, message: `Failed: ${err}` };
      }
    });

    actionExecutor.register("remember" as ActionType, async (params) => {
      const content = params.content as string || params.text as string || "";
      if (!content) {
        return { success: false, action: "remember" as ActionType, message: "Missing content to remember" };
      }

      const context = params.context as string || "";
      const importance = typeof params.importance === "number" ? params.importance : 0.6;
      const memoryType = (params.type as string) === "procedural" ? "procedural"
        : (params.type as string) === "semantic" ? "semantic"
        : "episodic";

      try {
        const { SmartMemory } = await import("./memory/smart-memory.ts");
        const userId = config.MY_TELEGRAM_ID;
        const userFolder = userManager.getUserFolder(userId);
        const memory = new SmartMemory(userFolder, userId);

        const fullContent = context ? `${content}\n\nBağlam: ${context}` : content;
        const id = await memory.store({
          type: memoryType,
          content: fullContent,
          importance,
          source: "cortex",
          sourceRef: params.sourceRef as string || undefined,
          metadata: {
            cortexSignal: params.signalSource || undefined,
            originalContext: context || undefined,
          },
        });

        memory.close();
        console.log(`[Cortex:Action] Remembered #${id}: ${content.slice(0, 80)}`);
        return { success: true, action: "remember" as ActionType, message: `Stored memory #${id}: ${content.slice(0, 50)}`, data: { memoryId: id } };
      } catch (err) {
        console.error(`[Cortex:Action] Remember failed:`, err);
        return { success: false, action: "remember" as ActionType, message: `Failed: ${err}` };
      }
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

    // Cortex heartbeat — periodic stats
    heartbeat("cortex", { event: "started", ...cortex.stats() });
    cortexHeartbeatInterval = setInterval(() => {
      if (cortex.isRunning()) {
        heartbeat("cortex", cortex.stats());
      }
    }, 30_000); // Every 30 seconds

    initProactive(bot);
    console.log("[Autonomous] Proactive features enabled");
  }, 1000);
}

const shutdown = async () => {
  console.log("\nKapatılıyor...");

  cortex.stop();
  if (cortexHeartbeatInterval) clearInterval(cortexHeartbeatInterval);
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

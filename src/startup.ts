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
import { cortex, actionExecutor, cortexBridge } from "./cortex/index.ts";
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

const aiAgentHeartbeatInterval = setInterval(() => {
  heartbeat("ai_agent", { event: "tick" });
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
    const userId = config.MY_TELEGRAM_ID;

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
      const from = params.from as string || params.origin as string || "";
      const to = params.to as string || params.destination as string || "";
      const mode = (params.mode as string || "DRIVE").toUpperCase() as "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT";

      if (!from || !to) {
        return { success: false, action: "calculate_route" as ActionType, message: "Missing from/origin or to/destination" };
      }

      console.log(`[Cortex:Action] Route requested: ${from} → ${to} (${mode})`);

      try {
        const { LocationService } = await import("./services/location.ts");
        const userId = config.MY_TELEGRAM_ID;
        const userDb = await userManager.getUserDb(userId);
        const locService = new LocationService(userDb);

        // Resolve origin: saved location name, coordinates, or address (geocode)
        const originCoords = await resolveLocationForCortex(locService, from);
        if (!originCoords) {
          const msg = `Baslangic bulunamadi: "${from}"`;
          await bot.api.sendMessage(config.MY_TELEGRAM_ID, msg);
          return { success: false, action: "calculate_route" as ActionType, message: msg };
        }

        // Resolve destination
        const destCoords = await resolveLocationForCortex(locService, to);
        if (!destCoords) {
          const msg = `Varis bulunamadi: "${to}"`;
          await bot.api.sendMessage(config.MY_TELEGRAM_ID, msg);
          return { success: false, action: "calculate_route" as ActionType, message: msg };
        }

        const result = await locService.getDistance(
          originCoords.lat, originCoords.lng,
          destCoords.lat, destCoords.lng,
          mode
        );

        if (!result) {
          const msg = `Rota bulunamadi: ${originCoords.name} → ${destCoords.name}`;
          await bot.api.sendMessage(config.MY_TELEGRAM_ID, msg);
          return { success: false, action: "calculate_route" as ActionType, message: msg };
        }

        const modeText: Record<string, string> = {
          DRIVE: "Arabayla", WALK: "Yuruyerek", BICYCLE: "Bisikletle", TRANSIT: "Toplu tasimayla",
        };

        const lines = [
          `📍 ${originCoords.name} → ${destCoords.name}`,
          `${modeText[mode] || mode}: ${result.distanceText}, ${result.durationText}`,
        ];
        if (result.durationInTrafficText && mode === "DRIVE") {
          lines.push(`Trafikle: ${result.durationInTrafficText}`);
        }

        const msg = lines.join("\n");
        await bot.api.sendMessage(config.MY_TELEGRAM_ID, msg);
        console.log(`[Cortex:Action] Route result: ${result.distanceText}, ${result.durationText}`);

        return {
          success: true,
          action: "calculate_route" as ActionType,
          message: msg,
          data: { from: originCoords.name, to: destCoords.name, distance: result.distanceText, duration: result.durationText },
        };
      } catch (err) {
        const msg = `Rota hesaplanamadi: ${err}`;
        console.error(`[Cortex:Action] calculate_route error:`, err);
        return { success: false, action: "calculate_route" as ActionType, message: msg };
      }
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
          return { success: true, action: "check_whatsapp" as ActionType, message: "No messages found", data: { chatJid, count: 0, notified: false } };
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

        return { success: true, action: "check_whatsapp" as ActionType, message: summary, data: { chatJid, count: messages.length, notified: !!params.notify } };
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

    // --- Heartbeat Action Handlers ---

    actionExecutor.register("morning_briefing" as ActionType, async (params) => {
      const message = params.message as string;
      if (!message) return { success: false, action: "morning_briefing" as ActionType, message: "No message" };
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
        return { success: true, action: "morning_briefing" as ActionType, message: "Morning briefing sent" };
      } catch (err) {
        console.error("[Heartbeat] morning_briefing send failed:", err);
        return { success: false, action: "morning_briefing" as ActionType, message: String(err) };
      }
    });

    actionExecutor.register("evening_summary" as ActionType, async (params) => {
      const message = params.message as string;
      if (!message) return { success: false, action: "evening_summary" as ActionType, message: "No message" };
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
        return { success: true, action: "evening_summary" as ActionType, message: "Evening summary sent" };
      } catch (err) {
        console.error("[Heartbeat] evening_summary send failed:", err);
        return { success: false, action: "evening_summary" as ActionType, message: String(err) };
      }
    });

    actionExecutor.register("goal_nudge" as ActionType, async (params) => {
      const message = params.message as string;
      if (!message) return { success: false, action: "goal_nudge" as ActionType, message: "No message" };
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
        return { success: true, action: "goal_nudge" as ActionType, message: "Goal nudge sent" };
      } catch (err) {
        console.error("[Heartbeat] goal_nudge send failed:", err);
        return { success: false, action: "goal_nudge" as ActionType, message: String(err) };
      }
    });

    actionExecutor.register("mood_check" as ActionType, async (params) => {
      const message = (params.message as string) || "Nasıl hissediyorsun?";
      try {
        await bot.api.sendMessage(userId, message, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "\u{1F60A} İyi", callback_data: "mood_great" },
              { text: "\u{1F610} Normal", callback_data: "mood_neutral" },
              { text: "\u{1F614} Düşük", callback_data: "mood_low" },
            ]]
          }
        });
        return { success: true, action: "mood_check" as ActionType, message: "Mood check sent" };
      } catch (err) {
        console.error("[Heartbeat] mood_check send failed:", err);
        return { success: false, action: "mood_check" as ActionType, message: String(err) };
      }
    });

    actionExecutor.register("memory_digest" as ActionType, async (params) => {
      const message = params.message as string;
      if (!message) return { success: false, action: "memory_digest" as ActionType, message: "No message" };
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML" });
        return { success: true, action: "memory_digest" as ActionType, message: "Memory digest sent" };
      } catch (err) {
        console.error("[Heartbeat] memory_digest send failed:", err);
        return { success: false, action: "memory_digest" as ActionType, message: String(err) };
      }
    });

    actionExecutor.register("think_and_note" as ActionType, async (params) => {
      const content = params.content as string;
      if (!content) return { success: false, action: "think_and_note" as ActionType, message: "No content" };
      try {
        const { SmartMemory } = await import("./memory/smart-memory.ts");
        const userFolder = userManager.getUserFolder(userId);
        const memory = new SmartMemory(userFolder, userId);
        await memory.store({
          type: "semantic",
          content,
          importance: 0.5,
          source: "self-reflection",
        });
        memory.close();
        console.log("[Heartbeat] think_and_note stored:", content.slice(0, 80));
        return { success: true, action: "think_and_note" as ActionType, message: "Note stored silently" };
      } catch (err) {
        console.error("[Heartbeat] think_and_note failed:", err);
        return { success: false, action: "think_and_note" as ActionType, message: String(err) };
      }
    });

    // Configure Cortex Bridge — tier-2 questions untuk user feedback
    cortexBridge.configure({
      onTier2Question: async (feedback) => {
        // Tier-2 sorularını sana Telegram'dan sor
        const { senderName, preview, salience, reasoner } = feedback;
        const questionText = `
🤔 <b>WhatsApp - ${senderName}</b> (tier-2 - önem: ${(salience.score * 100).toFixed(0)}%)

Mesaj: ${preview.slice(0, 150)}

<b>Cortex'in önerisi:</b> ${reasoner.reasoning}

<i>Cevap vermemi istersen haber ver.</i>
        `.trim();

        try {
          await bot.api.sendMessage(config.MY_TELEGRAM_ID, questionText, { parse_mode: "HTML" });
        } catch (err) {
          console.error(`[CortexBridge] Failed to send tier-2 question to user:`, err);
        }
      },
    });

    // Start Cortex — sinir ağı pipeline
    await cortex.start({
      userContextProvider: async (userId) => {
        // Basit context: kullanıcı bilgisi
        return `Kullanıcı: Fekrat (Yazılım Geliştirici). Zaman: ${new Date().toLocaleString("tr-TR")}`;
      },
      onActionExecuted: async (signal, result) => {
        console.log(`[Cortex] Action result: ${result.action} success=${result.success} ${result.message || ""}`);

        // Skip actions that already communicate with the user or need no notification
        const SILENT_ACTIONS: ActionType[] = [
          "send_message", "send_whatsapp", "none", "compound",
          "morning_briefing", "evening_summary", "goal_nudge", "mood_check", "memory_digest", "think_and_note",
        ];
        if (SILENT_ACTIONS.includes(result.action) || !result.success) return;

        let notification: string | null = null;

        switch (result.action) {
          case "check_whatsapp": {
            // Handler already sends Telegram if params.notify was set — skip to avoid duplicates
            const resultData = result.data as Record<string, unknown> | undefined;
            if (!resultData?.notified) {
              const count = resultData?.count ?? 0;
              const chatJid = (resultData?.chatJid as string) || "";
              const chatName = chatJid.split("@")[0] || "?";
              notification = `WhatsApp kontrol (${chatName}): ${count} mesaj bulundu.`;
            }
            break;
          }
          case "remember": {
            const preview = (result.message || "").replace(/^Stored memory #\d+:\s*/, "").slice(0, 80);
            notification = `Hafizama kaydettim: ${preview}`;
            break;
          }
          case "calculate_route": {
            const data = result.data as Record<string, unknown> | undefined;
            const from = data?.from || "?";
            const to = data?.to || "?";
            notification = `Rota: ${from} \u2192 ${to}`;
            break;
          }
          case "create_expectation": {
            const ctx = (result.data as Record<string, unknown>)?.expectation as Record<string, unknown> | undefined;
            const desc = (ctx?.context as string) || result.message || "";
            notification = `Beklenti olusturdum: ${desc.slice(0, 100)}`;
            break;
          }
          case "resolve_expectation": {
            const ctx = (result.data as Record<string, unknown>)?.expectation as Record<string, unknown> | undefined;
            const desc = (ctx?.context as string) || result.message || "";
            notification = `Beklenti cozuldu: ${desc.slice(0, 100)}`;
            break;
          }
        }

        if (notification) {
          try {
            await bot.api.sendMessage(config.MY_TELEGRAM_ID, notification);
          } catch (err) {
            console.error(`[Cortex] Action notification failed:`, err);
          }
        }
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

    // Start heartbeat signals (morning briefing, evening summary, goal nudges, etc.)
    if (config.ENABLE_HEARTBEAT_SIGNALS) {
      try {
        const { startHeartbeat } = await import("./cortex/heartbeat.ts");
        startHeartbeat(userId);
        console.log("[Startup] Heartbeat signals started");
      } catch (err) {
        console.error("[Startup] Heartbeat signals failed to start:", err);
      }
    }

    initProactive(bot);
    console.log("[Autonomous] Proactive features enabled");
  }, 1000);
}

// ── Helper: resolve location for Cortex calculate_route ──────────────────
async function resolveLocationForCortex(
  service: import("./services/location.ts").LocationService,
  input: string
): Promise<{ name: string; lat: number; lng: number } | null> {
  // 1. Saved location by name
  const saved = service.getLocationByName(input);
  if (saved) return { name: saved.name, lat: saved.latitude, lng: saved.longitude };

  // 2. Coordinate format: "41.0082,28.9784"
  const coordMatch = input.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]!);
    const lng = parseFloat(coordMatch[2]!);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { name: `${lat.toFixed(4)},${lng.toFixed(4)}`, lat, lng };
    }
  }

  // 3. Address geocoding
  try {
    const geocoded = await service.geocode(input);
    if (geocoded) {
      return { name: geocoded.formattedAddress, lat: geocoded.latitude, lng: geocoded.longitude };
    }
  } catch { /* geocode failed, return null */ }

  return null;
}

const shutdown = async () => {
  console.log("\nKapatılıyor...");

  cortex.stop();
  // Stop heartbeat signals
  try { const { stopHeartbeat } = await import("./cortex/heartbeat.ts"); stopHeartbeat(); } catch {}
  if (cortexHeartbeatInterval) clearInterval(cortexHeartbeatInterval);
  stopProjectionScheduler();

  if (config.ENABLE_AUTONOMOUS) {
    stopProactive();
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

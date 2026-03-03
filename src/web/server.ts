/**
 * Web Server
 * Bun.serve with static files and WebSocket support
 */

import { config } from "../config.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { validateToken, startTokenCleanup, stopTokenCleanup, generateMobileToken } from "./auth.ts";
import {
  handleOpen,
  handleClose,
  handleMessage,
  type WebSocketData,
} from "./websocket.ts";
import { handleMediaUpload, handleMediaTranscribe, handleMediaServe } from "./media.ts";
import { chat } from "../agent/chat.ts";
import { bot } from "../channels/telegram.ts";
import { userManager } from "../services/user-manager.ts";
import indexHtml from "./public/index.html";

let server: ReturnType<typeof Bun.serve> | null = null;
let webHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the web server
 */
export function startWebServer(): void {
  if (server) {
    console.warn("[Web] Server already running");
    return;
  }

  // Start token cleanup
  startTokenCleanup();

  server = Bun.serve<WebSocketData>({
    port: config.WEB_PORT,

    // HTTP routes
    routes: {
      // Serve index.html for root
      "/": indexHtml,

      // Health check
      "/health": () => new Response("OK"),

      // API: Get status
      "/api/status": () =>
        Response.json({
          status: "ok",
          version: "0.4.0",
          timestamp: Date.now(),
        }),
    },

    // Handle all other requests
    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const token = url.searchParams.get("token");

        if (!token) {
          return new Response("Missing token", { status: 401 });
        }

        const userId = validateToken(token);
        if (!userId) {
          return new Response("Invalid or expired token", { status: 401 });
        }

        // Upgrade to WebSocket
        const success = server.upgrade(req, {
          data: {
            userId,
            sessionId: null,
            connectedAt: Date.now(),
          } satisfies WebSocketData,
        });

        if (success) {
          return undefined;
        }

        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // POST /api/chat — REST API for external agents (Claude Code etc.)
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const authHeader = req.headers.get("authorization");
        const apiKey = config.COBRAIN_API_KEY;
        if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const body = await req.json();
          const {
            message,
            model,
            sessionKey,  // Agent'lar için izole session — ana session kirlenmez
            silent,      // true ise Telegram mirror kapalı (agent-to-agent çağrılar için)
          } = body as { message: string; model?: string; sessionKey?: string; silent?: boolean };
          if (!message) {
            return Response.json({ error: "message required" }, { status: 400 });
          }

          const userId = config.MY_TELEGRAM_ID;

          // Mirror to Telegram (silent=true ise atla — agent iç çağrıları için)
          if (!silent) {
            const label = sessionKey ? `📡 *[${sessionKey}]:*` : `📡 *API:*`;
            bot.api.sendMessage(userId, `${label} ${message}`, { parse_mode: "Markdown" }).catch(() => {});
          }

          const response = await chat(userId, message, undefined, model, sessionKey ? { sessionKey } : undefined);

          if (!silent) {
            const cleanMirror = response.content.replace(/<suggestions>[\s\S]*?<\/suggestions>\s*$/, '').trimEnd();
            bot.api.sendMessage(userId, cleanMirror).catch(() => {});
          }

          return Response.json(response);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      // POST /api/report — Agent'ların Cobrain'e rapor/mesaj gönderdiği endpoint
      // Agent'lar tamamlandığında veya onay istediklerinde buraya POST atar → inbox'a düşer
      if (url.pathname === "/api/report" && req.method === "POST") {
        const authHeader = req.headers.get("authorization");
        const apiKey = config.COBRAIN_API_KEY;
        if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const body = await req.json();
          const {
            agentId,
            subject,
            message: reportBody,
            priority = "normal",
          } = body as { agentId: string; subject: string; message: string; priority?: "urgent" | "normal" };

          if (!agentId || !subject || !reportBody) {
            return Response.json({ error: "agentId, subject, message required" }, { status: 400 });
          }

          const { inbox } = await import("../services/inbox.ts");
          await inbox.push({
            from: "brain-loop",
            subject: `[agent:${agentId}] ${subject}`,
            body: `Agent raporu — ${agentId}\n\n${reportBody}`,
            priority: priority as "urgent" | "normal",
            ttlMs: 2 * 60 * 60 * 1000,
          });

          console.log(`[API] Agent report received: ${agentId} — "${subject}"`);
          return Response.json({ ok: true, queued: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      // POST /api/auth/mobile — Authenticate mobile client, get long-lived token
      if (url.pathname === "/api/auth/mobile" && req.method === "POST") {
        try {
          const body = await req.json();
          const { apiKey } = body as { apiKey: string };
          if (!apiKey || apiKey !== config.COBRAIN_API_KEY) {
            return Response.json({ error: "Invalid API key" }, { status: 401 });
          }

          const userId = config.MY_TELEGRAM_ID;
          const { token, expiresAt } = generateMobileToken(userId);

          return Response.json({ token, userId, expiresAt });
        } catch (err) {
          return Response.json({ error: "Invalid request" }, { status: 400 });
        }
      }

      // POST /api/media/upload — Upload media file (image, audio)
      if (url.pathname === "/api/media/upload" && req.method === "POST") {
        return handleMediaUpload(req);
      }

      // POST /api/media/transcribe — Transcribe uploaded audio
      if (url.pathname === "/api/media/transcribe" && req.method === "POST") {
        return handleMediaTranscribe(req);
      }

      // GET /api/media/:id — Serve uploaded file
      const mediaMatch = url.pathname.match(/^\/api\/media\/([a-f0-9-]+)$/);
      if (mediaMatch?.[1] && req.method === "GET") {
        return handleMediaServe(req, mediaMatch[1]);
      }

      // 404 for unknown routes
      return new Response("Not Found", { status: 404 });
    },

    // WebSocket handlers
    websocket: {
      open(ws) {
        handleOpen(ws);
      },

      close(ws) {
        handleClose(ws);
      },

      async message(ws, message) {
        await handleMessage(ws, message);
      },

      // Ping/pong for keepalive
      ping(ws) {
        ws.pong();
      },

      // Connection limits
      maxPayloadLength: 1024 * 1024, // 1MB
      idleTimeout: 120, // 2 minutes
      backpressureLimit: 1024 * 1024 * 16, // 16MB
    },

    // Development options
    development: process.env.NODE_ENV !== "production"
      ? {
          hmr: true,
          console: true,
        }
      : false,
  });

  console.log(`[Web] Server started on http://localhost:${config.WEB_PORT}`);

  // Heartbeat: server started
  heartbeat("web_server", { event: "started", port: config.WEB_PORT });

  // Periodic heartbeat for web server
  webHeartbeatInterval = setInterval(() => {
    heartbeat("web_server", { event: "tick" });
  }, 10_000); // Every 10 seconds
}

/**
 * Stop the web server
 */
export function stopWebServer(): void {
  if (webHeartbeatInterval) {
    clearInterval(webHeartbeatInterval);
    webHeartbeatInterval = null;
  }
  if (server) {
    server.stop();
    server = null;
    stopTokenCleanup();
    console.log("[Web] Server stopped");
  }
}

/**
 * Get server info
 */
export function getWebServerInfo(): { running: boolean; port: number; url: string } {
  return {
    running: server !== null,
    port: config.WEB_PORT,
    url: config.WEB_URL,
  };
}

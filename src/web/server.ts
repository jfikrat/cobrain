/**
 * Web Server
 * Bun.serve with static files and WebSocket support
 */

import { config } from "../config.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { validateToken, startTokenCleanup, stopTokenCleanup } from "./auth.ts";
import {
  handleOpen,
  handleClose,
  handleMessage,
  type WebSocketData,
} from "./websocket.ts";
import {
  registerPhone,
  phoneHeartbeat,
  getPhones,
  savePhoneMedia,
  getPhoneMedia,
  sendPhoneCommand,
  isPhoneOnline,
} from "../services/phone-agent.ts";
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

      // ========== Phone Agent API ==========

      // Phone registration/heartbeat
      if (url.pathname === "/api/phone/register" && req.method === "POST") {
        try {
          const body = await req.json() as {
            id: string;
            name: string;
            port: number;
            capabilities?: string[];
          };

          // Get IP from request
          const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ||
                     req.headers.get("x-real-ip") ||
                     "unknown";

          const phone = registerPhone(
            body.id,
            body.name,
            ip,
            body.port,
            body.capabilities
          );

          return Response.json({ success: true, phone });
        } catch (err) {
          return Response.json({ success: false, error: String(err) }, { status: 400 });
        }
      }

      // Phone heartbeat
      if (url.pathname === "/api/phone/heartbeat" && req.method === "POST") {
        try {
          const body = await req.json() as { id: string };
          const success = phoneHeartbeat(body.id);
          return Response.json({ success });
        } catch (err) {
          return Response.json({ success: false, error: String(err) }, { status: 400 });
        }
      }

      // List phones
      if (url.pathname === "/api/phone/list" && req.method === "GET") {
        const phones = getPhones().map(p => ({
          ...p,
          online: isPhoneOnline(p.id),
        }));
        return Response.json({ phones });
      }

      // Receive photo from phone
      if (url.pathname === "/api/phone/photo" && req.method === "POST") {
        try {
          const formData = await req.formData();
          const file = formData.get("image") as File | null;
          const deviceId = formData.get("device_id") as string || "unknown";

          if (!file) {
            return Response.json({ success: false, error: "No image" }, { status: 400 });
          }

          const buffer = await file.arrayBuffer();
          const media = await savePhoneMedia(deviceId, "photo", buffer);

          console.log(`[Phone] Received photo from ${deviceId}: ${media.filename}`);
          return Response.json({ success: true, media });
        } catch (err) {
          return Response.json({ success: false, error: String(err) }, { status: 400 });
        }
      }

      // Receive audio from phone
      if (url.pathname === "/api/phone/audio" && req.method === "POST") {
        try {
          const formData = await req.formData();
          const file = formData.get("audio") as File | null;
          const deviceId = formData.get("device_id") as string || "unknown";

          if (!file) {
            return Response.json({ success: false, error: "No audio" }, { status: 400 });
          }

          const buffer = await file.arrayBuffer();
          const media = await savePhoneMedia(deviceId, "audio", buffer);

          console.log(`[Phone] Received audio from ${deviceId}: ${media.filename}`);
          return Response.json({ success: true, media });
        } catch (err) {
          return Response.json({ success: false, error: String(err) }, { status: 400 });
        }
      }

      // Receive location from phone
      if (url.pathname === "/api/phone/location" && req.method === "POST") {
        try {
          const body = await req.json() as {
            device_id: string;
            latitude: number;
            longitude: number;
            accuracy?: number;
          };

          console.log(`[Phone] Location from ${body.device_id}: ${body.latitude}, ${body.longitude}`);
          return Response.json({ success: true, received: body });
        } catch (err) {
          return Response.json({ success: false, error: String(err) }, { status: 400 });
        }
      }

      // Get recent media
      if (url.pathname === "/api/phone/media" && req.method === "GET") {
        const deviceId = url.searchParams.get("device_id") || undefined;
        const type = url.searchParams.get("type") as "photo" | "audio" | "video" | undefined;
        const limit = parseInt(url.searchParams.get("limit") || "10");

        const media = await getPhoneMedia(deviceId, type, limit);
        return Response.json({ media });
      }

      // Send command to phone
      if (url.pathname === "/api/phone/command" && req.method === "POST") {
        try {
          const body = await req.json() as {
            phone_id: string;
            command: "photo" | "audio" | "location" | "battery" | "info";
            params?: Record<string, unknown>;
          };

          const result = await sendPhoneCommand(body.phone_id, body.command, body.params);
          return Response.json(result);
        } catch (err) {
          return Response.json({ success: false, error: String(err) }, { status: 400 });
        }
      }

      // ========== End Phone Agent API ==========

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

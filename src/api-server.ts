/**
 * Minimal API Server
 * Only /api/chat, /api/report, /api/memory/*, and /health
 */

import { config } from "./config.ts";
import { heartbeat } from "./services/heartbeat.ts";
import { chat, type ChatOptions } from "./agent/chat.ts";
import { bot } from "./channels/telegram.ts";
import { userManager } from "./services/user-manager.ts";

let server: ReturnType<typeof Bun.serve> | null = null;
let apiHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

function authCheck(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  return !!config.COBRAIN_API_KEY && authHeader === `Bearer ${config.COBRAIN_API_KEY}`;
}

export function startApiServer(): void {
  if (server) {
    console.warn("[API] Server already running");
    return;
  }

  server = Bun.serve({
    port: config.API_PORT,

    routes: {
      "/health": () => new Response("OK"),
    },

    async fetch(req) {
      const url = new URL(req.url);

      // POST /api/chat — REST API for external agents
      if (url.pathname === "/api/chat" && req.method === "POST") {
        if (!authCheck(req)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const body = await req.json();
          const {
            message,
            model,
            sessionKey,
            silent,
            systemPromptOverride,
          } = body as {
            message: string;
            model?: string;
            sessionKey?: string;
            silent?: boolean;
            systemPromptOverride?: string;
          };

          if (!message) {
            return Response.json({ error: "message required" }, { status: 400 });
          }

          const userId = config.MY_TELEGRAM_ID;

          // Mirror to Telegram (skip if silent)
          if (!silent) {
            const label = sessionKey ? `📡 [${sessionKey}]:` : `📡 API:`;
            const mirrorText = `${label} ${message}`.slice(0, 4096);
            bot.api.sendMessage(userId, mirrorText, { parse_mode: "Markdown" })
              .catch(() => bot.api.sendMessage(userId, mirrorText).catch(() => {}));
          }

          const chatOptions: ChatOptions = {
            channel: "api",
            ...(sessionKey && { sessionKey }),
            ...(systemPromptOverride && { systemPromptOverride }),
            ...(silent && { silent }),
          };
          const response = await chat(userId, message, undefined, model, chatOptions);

          if (!silent) {
            const cleanMirror = response.content.replace(/<suggestions>[\s\S]*?<\/suggestions>\s*$/, '').trimEnd().slice(0, 4096);
            bot.api.sendMessage(userId, cleanMirror).catch(() => {});
          }

          return Response.json(response);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return Response.json({ error: msg }, { status: 500 });
        }
      }

      // POST /api/report — Agent reports → inbox
      if (url.pathname === "/api/report" && req.method === "POST") {
        if (!authCheck(req)) {
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

          if (agentId === "wa") {
            console.log(`[API] WA Agent report (log-only): "${subject}"`);
            return Response.json({ ok: true, logged: true });
          }

          const { inbox } = await import("./services/inbox.ts");
          await inbox.push({
            from: "brain-loop",
            subject: `[agent:${agentId}] ${subject}`,
            body: `Agent report — ${agentId}\n\n${reportBody}`,
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

      // GET /api/memory/recall — Agent memory read
      if (url.pathname === "/api/memory/recall" && req.method === "GET") {
        if (!authCheck(req)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          const query = url.searchParams.get("query") || "all";
          const days = parseInt(url.searchParams.get("days") || "30");
          const userId = config.MY_TELEGRAM_ID;
          const { FileMemory } = await import("./memory/file-memory.ts");
          const userFolder = userManager.getUserFolder(userId);
          const memory = new FileMemory(userFolder);
          const facts = await memory.readFacts();
          const events = await memory.readRecentEvents(days);
          return Response.json({ facts: facts?.slice(0, 3000) || "", events: events?.slice(0, 1000) || "", query });
        } catch (err) {
          return Response.json({ error: String(err).slice(0, 200) }, { status: 500 });
        }
      }

      // POST /api/memory/remember — Agent memory write
      if (url.pathname === "/api/memory/remember" && req.method === "POST") {
        if (!authCheck(req)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          const body = await req.json() as { content: string; type?: "semantic" | "episodic"; section?: string };
          if (!body.content) return Response.json({ error: "content required" }, { status: 400 });
          const userId = config.MY_TELEGRAM_ID;
          const { FileMemory } = await import("./memory/file-memory.ts");
          const userFolder = userManager.getUserFolder(userId);
          const memory = new FileMemory(userFolder);
          if (body.type === "episodic") {
            await memory.logEvent(`[wa-agent] ${body.content}`);
          } else {
            await memory.storeFact(body.section || "WhatsApp", `[wa-agent] ${body.content}`);
          }
          console.log(`[API] Memory written by agent: "${body.content.slice(0, 60)}"`);
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: String(err).slice(0, 200) }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`[API] Server started on http://localhost:${config.API_PORT}`);
  heartbeat("api_server", { event: "started", port: config.API_PORT });

  apiHeartbeatInterval = setInterval(() => {
    heartbeat("api_server", { event: "tick" });
  }, 10_000);
}

export function stopApiServer(): void {
  if (apiHeartbeatInterval) {
    clearInterval(apiHeartbeatInterval);
    apiHeartbeatInterval = null;
  }
  if (server) {
    server.stop();
    server = null;
    console.log("[API] Server stopped");
  }
}

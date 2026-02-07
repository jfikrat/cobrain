/**
 * Cobrain Agent Chat
 * Ana chat fonksiyonu - Claude Agent SDK kullanarak
 * v0.3 - Dynamic Persona System
 */

import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { userManager } from "../services/user-manager.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { generateSystemPrompt, generatePersonaSystemPrompt } from "./prompts.ts";
import { createMemoryServer } from "./tools/memory.ts";
import { createGDriveServer } from "./tools/gdrive.ts";
import { createGoalsServer } from "./tools/goals.ts";
import { createPersonaServer } from "./tools/persona.ts";
import { createTelegramServer, getTelegramBot } from "./tools/telegram.ts";
import { getTimeServer } from "./tools/time.ts";
import { createMoodServer } from "./tools/mood.ts";
import { createPhoneServer } from "./tools/phone.ts";
import { createN8nServer } from "./tools/n8n.ts";

import { getPersonaService } from "../services/persona.ts";
import { needsPermission, askToolPermission, type PermissionMode } from "./permissions.ts";
import { UserMemory } from "../memory/sqlite.ts";
import { config } from "../config.ts";

export interface ChatResponse {
  content: string;
  sessionId: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  toolsUsed: string[];
}

// Multimodal content types for images
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string; // base64 encoded image
  };
}

export interface TextContent {
  type: "text";
  text: string;
}

export type MessageContent = TextContent | ImageContent;

export interface MultimodalMessage {
  text: string;
  images?: Array<{
    data: string; // base64
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  }>;
}

// Session ID cache per user
const userSessions = new Map<number, string>();

// Session TTL: 2 hours - after this, start a fresh session
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

async function getOrResumeSession(userId: number): Promise<string | undefined> {
  // 1. In-memory cache (process lifetime)
  const cached = userSessions.get(userId);
  if (cached) return cached;

  // 2. DB'den son aktif session
  try {
    const userDb = await userManager.getUserDb(userId);
    const memory = new UserMemory(userDb);
    const session = memory.getSession();
    if (!session?.lastUsedAt) return undefined;

    // 3. TTL kontrolü
    const age = Date.now() - new Date(session.lastUsedAt).getTime();
    if (age > SESSION_TTL_MS) {
      console.log(`[Agent] Session expired (${Math.round(age / 60000)}min), starting fresh`);
      return undefined;
    }

    console.log(`[Agent] Resuming session from DB (${Math.round(age / 60000)}min old)`);
    userSessions.set(userId, session.id);
    return session.id;
  } catch {
    return undefined;
  }
}

// MCP Server cache per user
const userMemoryServers = new Map<number, ReturnType<typeof createMemoryServer>>();
const userGoalsServers = new Map<number, ReturnType<typeof createGoalsServer>>();
const userPersonaServers = new Map<number, ReturnType<typeof createPersonaServer>>();
const userMoodServers = new Map<number, ReturnType<typeof createMoodServer>>();


// Shared servers (same for all users)
let gdriveServer: ReturnType<typeof createGDriveServer> | null = null;
let telegramServer: ReturnType<typeof createTelegramServer> | null = null;
let phoneServer: ReturnType<typeof createPhoneServer> | null = null;
let n8nServer: ReturnType<typeof createN8nServer> | null = null;

/**
 * Get or create memory server for user
 */
function getMemoryServer(userId: number) {
  let server = userMemoryServers.get(userId);
  if (!server) {
    server = createMemoryServer(userId);
    userMemoryServers.set(userId, server);
  }
  return server;
}

/**
 * Get or create GDrive server
 */
function getGDriveServer() {
  if (!gdriveServer) {
    gdriveServer = createGDriveServer();
  }
  return gdriveServer;
}

/**
 * Get or create telegram server (shared)
 */
function getTelegramServer() {
  if (!telegramServer) {
    telegramServer = createTelegramServer();
  }
  return telegramServer;
}

/**
 * Get or create phone server (shared)
 */
function getPhoneServer() {
  if (!phoneServer) {
    phoneServer = createPhoneServer();
  }
  return phoneServer;
}

/**
 * Get or create n8n server (shared)
 */
function getN8nServer() {
  if (!n8nServer) {
    n8nServer = createN8nServer();
  }
  return n8nServer;
}

/**
 * Get or create goals server for user
 */
function getGoalsServer(userId: number) {
  let server = userGoalsServers.get(userId);
  if (!server) {
    server = createGoalsServer(userId);
    userGoalsServers.set(userId, server);
  }
  return server;
}

/**
 * Get or create persona server for user
 */
function getPersonaServer(userId: number) {
  let server = userPersonaServers.get(userId);
  if (!server) {
    server = createPersonaServer(userId);
    userPersonaServers.set(userId, server);
  }
  return server;
}

/**
 * Get or create mood server for user
 */
function getMoodServer(userId: number) {
  let server = userMoodServers.get(userId);
  if (!server) {
    server = createMoodServer(userId);
    userMoodServers.set(userId, server);
  }
  return server;
}


/**
 * Extract text content from assistant message
 */
function extractTextContent(message: SDKMessage): string {
  if (message.type !== "assistant") return "";

  const content = message.message.content;
  if (typeof content === "string") return content;

  // Content is an array of blocks
  return (content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

/**
 * Build multimodal content array for Claude API
 */
function buildMessageContent(message: string | MultimodalMessage): MessageContent[] {
  if (typeof message === "string") {
    return [{ type: "text", text: message }];
  }

  const content: MessageContent[] = [];

  // Add text first
  if (message.text) {
    content.push({ type: "text", text: message.text });
  }

  // Add images
  if (message.images && message.images.length > 0) {
    for (const img of message.images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.data,
        },
      });
    }
  }

  return content;
}

/**
 * Main chat function using Agent SDK
 * Supports both text-only and multimodal (with images) messages
 */
export async function chat(userId: number, message: string | MultimodalMessage): Promise<ChatResponse> {
  // Ensure user exists and get settings
  await userManager.ensureUser(userId);
  const settings = await userManager.getUserSettings(userId);
  const userFolder = userManager.getUserFolder(userId);

  // Get persona and generate system prompt
  const personaService = await getPersonaService(userId);
  const persona = await personaService.getActivePersona();
  const systemPrompt = generatePersonaSystemPrompt(persona);

  // Get or resume session (checks in-memory cache, then DB with TTL)
  const existingSessionId = await getOrResumeSession(userId);

  // Track tools used
  const toolsUsed: string[] = [];
  let lastAssistantContent = "";
  let sessionId = "";
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;

  // Build the message content (text or multimodal)
  const messageContent = buildMessageContent(message);
  const messagePreview = typeof message === "string" ? message.slice(0, 50) : message.text.slice(0, 50);
  const hasImages = typeof message !== "string" && message.images && message.images.length > 0;

  console.log(`[Agent] Chat started for user ${userId}: "${messagePreview}..."${hasImages ? " (with images)" : ""}`);

  try {
    // Create the prompt - use SDKUserMessage for multimodal content
    const prompt = hasImages
      ? (async function* () {
          yield {
            type: "user" as const,
            message: {
              role: "user" as const,
              content: messageContent,
            },
            parent_tool_use_id: null,
            session_id: existingSessionId || "",
          };
        })()
      : (typeof message === "string" ? message : message.text);

    const queryResult = query({
      prompt,
      options: {
        // Model from config (default: opus)
        model: config.AGENT_MODEL,

        // Working directory - user's folder
        cwd: userFolder,

        // System prompt with Cobrain persona
        systemPrompt,

        // Resume previous session if exists
        resume: existingSessionId,

        // Don't load CLAUDE.md - use only our custom systemPrompt
        // This prevents Claude Code identity from leaking through
        settingSources: [],

        // MCP Servers (createSdkMcpServer returns full config)
        mcpServers: {
          memory: getMemoryServer(userId),
          gdrive: getGDriveServer(),

          n8n: getN8nServer(),
          goals: getGoalsServer(userId),
          persona: getPersonaServer(userId),
          telegram: getTelegramServer(),
          time: getTimeServer(),
          mood: getMoodServer(userId),
          phone: getPhoneServer(),
          // Helm - Browser control via Chrome extension
          helm: {
            type: "stdio" as const,
            command: "bun",
            args: ["run", "/home/fjds/projects/helm-browser/server/index.ts"],
          },
          // Squad - Multi-agent MCP (Codex, Gemini, Claude Code)
          squad: {
            type: "stdio" as const,
            command: "bun",
            args: ["run", "/home/fjds/projects/squad/src/index.ts"],
          },
          // WhatsApp - Messaging via Baileys
          whatsapp: {
            type: "stdio" as const,
            command: "bun",
            args: ["run", "/home/fjds/projects/whatsapp/mcp-server.ts"],
          },
        },

        // Subagents for specialized tasks
        agents: {
          researcher: {
            description: "Web'de araştırma yapar, bilgi toplar. Güncel bilgi, haber, teknik dokümantasyon aramak için kullan.",
            prompt: "Sen bir araştırmacısın. Verilen konuyu web'de araştır, güvenilir kaynaklardan bilgi topla ve özet sun. Türkçe yanıt ver.",
            tools: ["WebSearch", "WebFetch"],
          },
          summarizer: {
            description: "Uzun metinleri özetler. Makale, döküman, konuşma özeti için kullan.",
            prompt: "Sen bir özetleyicisin. Verilen metni kısa, öz ve anlaşılır şekilde özetle. Önemli noktaları vurgula. Türkçe yanıt ver.",
          },
          "memory-expert": {
            description: "Kullanıcının hafızasında arama ve analiz yapar. Geçmiş konuşmalar, kaydedilen bilgiler için kullan.",
            prompt: "Sen hafıza uzmanısın. Kullanıcının hafızasında detaylı arama yap, ilgili bilgileri bul ve özetle. Türkçe yanıt ver.",
            tools: ["mcp__memory__recall", "mcp__memory__memory_stats"],
          },
        },

        // Hooks for logging and permission control
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  const input = hookInput as PreToolUseHookInput;
                  const toolName = input.tool_name;
                  const toolInput = input.tool_input as Record<string, unknown>;

                  console.log(`[Agent] Tool: ${toolName}`);
                  toolsUsed.push(toolName);

                  // Send status message to Telegram
                  try {
                    let statusMessage = "";

                    // Customize status message based on tool
                    switch (toolName) {
                      case "WebSearch":
                        statusMessage = `🔍 Web'de araştırma yapıyorum: "${toolInput.query || ""}"`;
                        break;
                      case "WebFetch":
                        statusMessage = `🌐 Web sayfasını okuyorum...`;
                        break;
                      case "Read":
                        statusMessage = `📄 Dosya okuyorum: ${(toolInput.file_path as string || "").split("/").pop()}`;
                        break;
                      case "Write":
                        statusMessage = `✍️ Dosya yazıyorum: ${(toolInput.file_path as string || "").split("/").pop()}`;
                        break;
                      case "Edit":
                        statusMessage = `📝 Dosya düzenliyorum: ${(toolInput.file_path as string || "").split("/").pop()}`;
                        break;
                      case "Bash":
                        statusMessage = `⚡ Komut çalıştırıyorum: ${(toolInput.command as string || "").slice(0, 50)}...`;
                        break;
                      case "Glob":
                        statusMessage = `🔎 Dosya arıyorum: ${toolInput.pattern}`;
                        break;
                      case "Grep":
                        statusMessage = `🔍 İçerik arıyorum: "${(toolInput.pattern as string || "").slice(0, 30)}..."`;
                        break;
                      case "mcp__memory__remember":
                        statusMessage = `🧠 Hafızaya kaydediyorum...`;
                        break;
                      case "mcp__memory__recall":
                        statusMessage = `🧠 Hafızamı tarıyorum: "${toolInput.query}"`;
                        break;
                      case "mcp__goals__create_goal":
                        statusMessage = `🎯 Hedef oluşturuyorum...`;
                        break;
                      case "mcp__goals__create_reminder":
                        statusMessage = `⏰ Hatırlatıcı kuruyorum...`;
                        break;
                      case "mcp__gdrive__gdrive_list":
                        statusMessage = `📁 Google Drive'ı tarıyorum...`;
                        break;
                      case "mcp__squad__codex":
                        statusMessage = `🤖 Codex ile analiz yapıyorum...`;
                        break;
                      case "mcp__squad__gemini":
                        statusMessage = `🤖 Gemini ile kod üretiyorum...`;
                        break;
                      case "mcp__squad__claude":
                        statusMessage = `🤖 Claude Code ile görüşüyorum...`;
                        break;
                      case "Task":
                        statusMessage = `🚀 Yardımcı agent başlatıyorum: ${toolInput.description}`;
                        break;
                      case "TodoWrite":
                        statusMessage = `📋 Görev listesini güncelliyorum...`;
                        break;
                      case "mcp__phone__phone_photo":
                        statusMessage = `📸 Telefondan fotoğraf çekiyorum...`;
                        break;
                      case "mcp__phone__phone_audio":
                        statusMessage = `🎤 Telefondan ses kaydediyorum...`;
                        break;
                      case "mcp__phone__phone_location":
                        statusMessage = `📍 Telefonun konumunu alıyorum...`;
                        break;
                      case "mcp__phone__phone_battery":
                        statusMessage = `🔋 Telefon pil durumunu kontrol ediyorum...`;
                        break;
                      case "mcp__phone__phone_list":
                        statusMessage = `📱 Bağlı telefonları kontrol ediyorum...`;
                        break;
                      default:
                        if (!toolName.startsWith("telegram_")) {
                          // Skip telegram tools to avoid loops
                          statusMessage = `🔧 ${toolName} kullanıyorum...`;
                        }
                    }

                    // Send via telegram bot if available
                    if (statusMessage) {
                      const bot = getTelegramBot();
                      if (bot && bot.api) {
                        await bot.api.sendMessage(userId, statusMessage);
                      }
                    }
                  } catch (error) {
                    // Silently fail - don't interrupt main flow
                    console.error("[Agent] Failed to send status message:", error);
                  }

                  // User's permission mode or fallback to global config
                  const mode = (settings.permissionMode || config.PERMISSION_MODE) as PermissionMode;

                  // Check if permission is needed
                  if (needsPermission(mode, toolName, toolInput)) {
                    console.log(`[Agent] Asking permission for ${toolName}...`);

                    // Create an AbortController for the permission request
                    const abortController = new AbortController();

                    const result = await askToolPermission(
                      userId,
                      toolName,
                      toolInput,
                      abortController.signal
                    );

                    if (result.behavior === "deny") {
                      console.log(`[Agent] Permission denied for ${toolName}`);
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision: "deny" as const,
                          permissionDecisionReason: result.message || "Kullanıcı tarafından reddedildi",
                        },
                      };
                    }

                    console.log(`[Agent] Permission granted for ${toolName}`);
                  }

                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse" as const,
                      permissionDecision: "allow" as const,
                    },
                  };
                },
              ],
            },
          ],
        },

        // Limit turns to prevent runaway
        maxTurns: config.MAX_AGENT_TURNS,
      },
    });

    // Process messages
    for await (const msg of queryResult) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") {
            sessionId = msg.session_id;
            userSessions.set(userId, sessionId);
            // Persist to DB for cross-restart recovery
            try {
              const userDb = await userManager.getUserDb(userId);
              const mem = new UserMemory(userDb);
              mem.setSession(sessionId);
            } catch (e) {
              console.warn(`[Agent] Session persist failed:`, e);
            }
            console.log(`[Agent] Session: ${sessionId.slice(0, 8)}...`);
          }
          break;

        case "assistant":
          lastAssistantContent = extractTextContent(msg);
          break;

        case "result":
          const result = msg as SDKResultMessage;
          if (result.subtype === "success") {
            totalCost = result.total_cost_usd;
            inputTokens = result.usage.input_tokens;
            outputTokens = result.usage.output_tokens;
            numTurns = result.num_turns;

            // Use result text if no assistant message captured
            if (!lastAssistantContent && result.result) {
              lastAssistantContent = result.result;
            }
          } else {
            // Error case
            console.error(`[Agent] Error: ${result.subtype}`, (result as any).errors);
            if (!lastAssistantContent) {
              lastAssistantContent = `Bir hata oluştu: ${result.subtype}`;
            }
          }
          break;
      }
    }

    console.log(
      `[Agent] Completed: ${numTurns} turns, ${toolsUsed.length} tools, $${totalCost.toFixed(4)}`
    );

    // Heartbeat: agent completed successfully
    heartbeat("ai_agent", { event: "completed", turns: numTurns, tools: toolsUsed.length, cost: totalCost });

    return {
      content: lastAssistantContent || "Yanıt alınamadı.",
      sessionId,
      totalCost,
      inputTokens,
      outputTokens,
      numTurns,
      toolsUsed: [...new Set(toolsUsed)], // Unique tools
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Stale session from DB — SDK can't find it after restart
    // Clear and retry once with a fresh session
    if (existingSessionId && errorMessage.includes("exited with code")) {
      console.warn(`[Agent] Stale session detected, retrying with fresh session...`);
      userSessions.delete(userId);
      try {
        const userDb = await userManager.getUserDb(userId);
        const mem = new UserMemory(userDb);
        mem.clearSession();
      } catch {}
      return chat(userId, message);
    }

    console.error("[Agent] Chat error:", error);

    // Clear session on error to start fresh next time
    userSessions.delete(userId);

    return {
      content: `Hata: ${errorMessage}`,
      sessionId: "",
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      numTurns: 0,
      toolsUsed: [],
    };
  }
}

/**
 * Clear user session
 */
export function clearSession(userId: number): void {
  userSessions.delete(userId);
  console.log(`[Agent] Session cleared for user ${userId}`);
}

/**
 * Get session info
 */
export function getSessionInfo(userId: number): { sessionId: string | null } {
  return {
    sessionId: userSessions.get(userId) || null,
  };
}

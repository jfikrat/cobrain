/**
 * Agent hooks — PreToolUse (logging, permissions) + PreCompact (memory flush)
 * Extracted from chat.ts for modularity
 */

import type { PreToolUseHookInput, PreCompactHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getTelegramBot } from "./tools/telegram.ts";
import { needsPermission, askToolPermission, type PermissionMode } from "./permissions.ts";
import { config } from "../config.ts";
import { getEventStore } from "../brain/event-store.ts";
import { userManager } from "../services/user-manager.ts";
import { SmartMemory } from "../memory/smart-memory.ts";
import { UserMemory } from "../memory/sqlite.ts";
import { isHaikuAvailable } from "../services/haiku.ts";

// Tool status message lookup (exact match)
type StatusHandler = (i: Record<string, unknown>) => string;
const TOOL_STATUS: Map<string, StatusHandler> = new Map([
  ["WebSearch", (i) => `🔍 Web'de araştırma yapıyorum: "${i.query || ""}"`],
  ["WebFetch", () => `🌐 Web sayfasını okuyorum...`],
  ["Read", (i) => `📄 Dosya okuyorum: ${(i.file_path as string || "").split("/").pop()}`],
  ["Write", (i) => `✍️ Dosya yazıyorum: ${(i.file_path as string || "").split("/").pop()}`],
  ["Edit", (i) => `📝 Dosya düzenliyorum: ${(i.file_path as string || "").split("/").pop()}`],
  ["Bash", (i) => `⚡ Komut çalıştırıyorum: ${(i.command as string || "").slice(0, 50)}...`],
  ["Glob", (i) => `🔎 Dosya arıyorum: ${i.pattern}`],
  ["Grep", (i) => `🔍 İçerik arıyorum: "${(i.pattern as string || "").slice(0, 30)}..."`],
  ["mcp__memory__remember", () => `🧠 Hafızaya kaydediyorum...`],
  ["mcp__memory__recall", (i) => `🧠 Hafızamı tarıyorum: "${i.query}"`],
  ["mcp__goals__create_goal", () => `🎯 Hedef oluşturuyorum...`],
  ["mcp__goals__create_reminder", () => `⏰ Hatırlatıcı kuruyorum...`],
  ["mcp__location__save_location", (i) => `📍 Konum kaydediyorum: "${i.name}"`],
  ["mcp__location__get_distance", (i) => `🗺️ Mesafe hesaplıyorum: ${i.origin} → ${i.destination}`],
  ["mcp__location__geocode", () => `🗺️ Adres çözümlüyorum...`],
  ["mcp__location__list_locations", () => `📍 Kayıtlı konumları listeliyorum...`],
  ["Task", (i) => `🚀 Yardımcı agent başlatıyorum: ${i.description}`],
  ["TodoWrite", () => `📋 Görev listesini güncelliyorum...`],
]);

// Tool status message lookup (pattern/includes match)
const TOOL_STATUS_PATTERN: [string, StatusHandler][] = [
  ["gdrive_list", () => `📁 Google Drive'ı tarıyorum...`],
  ["gdrive_search", () => `📁 Google Drive'ı tarıyorum...`],
  ["gdrive_dirs", () => `📁 Google Drive'ı tarıyorum...`],
  ["gdrive_link", () => `📁 Google Drive dosya bilgisi alıyorum...`],
  ["gdrive_info", () => `📁 Google Drive dosya bilgisi alıyorum...`],
  ["squad_codex", () => `🤖 Codex ile analiz yapıyorum...`],
  ["squad_gemini", () => `🤖 Gemini ile kod üretiyorum...`],
  ["squad_claude", () => `🤖 Claude Code ile görüşüyorum...`],
  ["helm_browser_navigate", () => `🌐 Sayfaya gidiyorum...`],
  ["helm_browser_screenshot", () => `📸 Ekran görüntüsü alıyorum...`],
  ["helm_browser_click", () => `👆 Elemente tıklıyorum...`],
  ["helm_browser_type", () => `⌨️ Metin yazıyorum...`],
  ["whatsapp_send_message", () => `💬 WhatsApp mesajı gönderiyorum...`],
  ["whatsapp_get_messages", () => `💬 WhatsApp mesajlarını okuyorum...`],
  ["whatsapp_get_chats", () => `💬 WhatsApp sohbetlerini listeliyorum...`],
  ["whatsapp_get_contacts", () => `📇 WhatsApp kişilerini arıyorum...`],
];

export function getToolStatusMessage(name: string, input: Record<string, unknown>): string {
  const exact = TOOL_STATUS.get(name);
  if (exact) return exact(input);
  for (const [pattern, handler] of TOOL_STATUS_PATTERN) {
    if (name.includes(pattern)) return handler(input);
  }
  // Silent: gateway management, telegram (avoid loops), SDK internals
  if (
    name.includes("gateway__") ||
    name.startsWith("telegram_") ||
    name.startsWith("mcp__telegram_") ||
    name === "AskUserQuestion" ||
    name === "EnterPlanMode" ||
    name === "ExitPlanMode"
  ) return "";
  return `🔧 ${name} kullanıyorum...`;
}

/**
 * Create PreToolUse hooks for the agent query
 */
export function createPreToolUseHooks(params: {
  userId: number;
  toolsUsed: string[];
  traceId?: string;
  permissionMode: string;
}) {
  const { userId, toolsUsed, traceId, permissionMode } = params;

  return [
    {
      hooks: [
        async (hookInput: unknown) => {
          const input = hookInput as PreToolUseHookInput;
          const toolName = input.tool_name;
          const toolInput = input.tool_input as Record<string, unknown>;

          console.log(`[Cortex] Tool: ${toolName}`);
          toolsUsed.push(toolName);

          // Event: tool called
          if (config.FF_BRAIN_EVENTS && traceId) {
            const eventStore = getEventStore();
            if (eventStore) {
              eventStore.append({
                userId,
                traceId,
                eventType: "agent.tool.called",
                actor: "agent",
                payload: { tool: toolName },
              });
            }
          }

          // Send status message to Telegram
          try {
            const statusMessage = getToolStatusMessage(toolName, toolInput);
            if (statusMessage) {
              const bot = getTelegramBot();
              if (bot && bot.api) {
                await bot.api.sendMessage(userId, statusMessage);
              }
            }
          } catch (error) {
            // Silently fail - don't interrupt main flow
            console.error("[Cortex] Failed to send status message:", error);
          }

          // User's permission mode or fallback to global config
          const mode = permissionMode as PermissionMode;

          // Check if permission is needed
          if (needsPermission(mode, toolName, toolInput)) {
            console.log(`[Cortex] Asking permission for ${toolName}...`);

            // Create an AbortController for the permission request
            const abortController = new AbortController();

            const result = await askToolPermission(
              userId,
              toolName,
              toolInput,
              abortController.signal
            );

            if (result.behavior === "deny") {
              console.log(`[Cortex] Permission denied for ${toolName}`);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: result.message || "Kullanıcı tarafından reddedildi",
                },
              };
            }

            console.log(`[Cortex] Permission granted for ${toolName}`);
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
  ];
}

/**
 * Create PreCompact hook — flush notable facts to memory before context compaction
 */
export function createPreCompactHook(userId: number) {
  return [{
    hooks: [async (raw: unknown) => {
      try {
        await flushMemoryBeforeCompact(userId);
      } catch (err) {
        console.error('[PreCompact] Memory flush failed:', err);
      }
      return { continue: true };
    }]
  }];
}

async function flushMemoryBeforeCompact(userId: number) {
  if (!isHaikuAvailable()) return;

  const userDb = await userManager.getUserDb(userId);
  const userMemory = new UserMemory(userDb);
  const history = userMemory.getHistory(10);

  if (history.length < 3) return;

  const userFolder = userManager.getUserFolder(userId);
  const smartMemory = new SmartMemory(userFolder, userId);

  try {
    const conversationText = history
      .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "");
    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      generationConfig: { maxOutputTokens: 400 },
      systemInstruction: "Konuşmadan kalıcı değerli bilgileri çıkar. Her bilgiyi ayrı satırda yaz. Geçici/selamlama bilgilerini ATLA. Sadece bilgi satırları yaz, başka bir şey yazma. Bilgi yoksa BOŞ yaz.",
    });

    const prompt = `Bu konuşmadan kullanıcı hakkında kalıcı değerli bilgileri (tercihler, kişisel bilgi, öğrenilmiş şeyler, kararlar) çıkar:

${conversationText}

Bilgiler (her satırda bir tane):`;

    const TIMEOUT_MS = 15_000;
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("[PreCompact] Gemini timed out")), TIMEOUT_MS);
    });

    const result = await Promise.race([
      model.generateContent(prompt),
      timeoutPromise,
    ]).finally(() => clearTimeout(timeoutId!));

    const text = result.response.text().trim();
    if (!text || text === "BOŞ" || text.length < 10) return;

    const facts = text.split("\n")
      .map(line => line.replace(/^[-•*]\s*/, "").trim())
      .filter(line => line.length > 10 && line.length < 500);

    let stored = 0;
    for (const fact of facts.slice(0, 5)) {
      try {
        await smartMemory.store({
          type: "semantic",
          content: fact,
          importance: 0.6,
          source: "pre-compact-flush",
        });
        stored++;
      } catch {}
    }

    if (stored > 0) {
      console.log(`[PreCompact] Flushed ${stored} facts to memory for user ${userId}`);
    }
  } finally {
    smartMemory.close();
  }
}

/**
 * Agent hooks — PreToolUse (logging, permissions)
 * Extracted from chat.ts for modularity
 */

import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getTelegramBot } from "./tools/telegram.ts";
import { needsPermission, askToolPermission, type PermissionMode } from "./permissions.ts";
import { config } from "../config.ts";
import { getEventStore } from "../brain/event-store.ts";
import { userManager } from "../services/user-manager.ts";
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
  ["calendar_today", () => `📅 Bugünkü programa bakıyorum...`],
  ["calendar_agenda", () => `📅 Takvime bakıyorum...`],
  ["calendar_search", () => `🔍 Takvimde etkinlik arıyorum...`],
  ["calendar_add", () => `📅 Takvime etkinlik ekliyorum...`],
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
  ["gmail_inbox", () => `📬 Gmail gelen kutusuna bakıyorum...`],
  ["gmail_search", (i) => `🔍 Gmail'de arıyorum: "${(i.query as string || "").slice(0, 30)}"`],
  ["gmail_read", () => `📧 Maili okuyorum...`],
  ["gmail_send", (i) => `📤 Mail gönderiyorum: "${i.subject}"`],
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

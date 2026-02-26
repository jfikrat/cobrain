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

// ========== Tool Stream Notifier ==========
// Streams tool status into a single Telegram message (edit-in-place)

export class ToolStreamNotifier {
  private messageId: number | null = null;
  private lines: string[] = [];
  private userId: number;
  private lastEditTime = 0;
  private pendingEdit: Timer | null = null;
  private startTime = Date.now();
  private toolCount = 0;

  private static readonly MIN_EDIT_INTERVAL = 1500; // Telegram rate limit safety
  private static readonly MAX_MSG_LENGTH = 4096;
  private static readonly HEADER = "🧠 Cortex çalışıyor...";

  constructor(userId: number) {
    this.userId = userId;
  }

  async append(line: string): Promise<void> {
    this.toolCount++;
    const ts = new Date().toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "Europe/Istanbul",
    });
    this.lines.push(`${ts} ${line}`);
    await this.flush();
  }

  async complete(opts: { cost?: number; error?: string } = {}): Promise<void> {
    if (this.toolCount === 0) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);

    if (opts.error) {
      this.lines.push(`\n❌ Hata: ${opts.error.slice(0, 200)}`);
    } else {
      const costStr = opts.cost ? `, $${opts.cost.toFixed(3)}` : "";
      this.lines.push(`\n✅ Tamamlandı (${this.toolCount} tool, ${elapsed}s${costStr})`);
    }

    // Force flush (ignore rate limit)
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
    await this.sendOrEdit();
  }

  private buildMessage(): string {
    let text = ToolStreamNotifier.HEADER + "\n\n" + this.lines.join("\n");

    // Trim oldest lines if exceeding Telegram limit
    while (text.length > ToolStreamNotifier.MAX_MSG_LENGTH && this.lines.length > 2) {
      this.lines.shift();
      text = ToolStreamNotifier.HEADER + "\n\n...\n" + this.lines.join("\n");
    }

    return text;
  }

  private async flush(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastEditTime;

    if (elapsed >= ToolStreamNotifier.MIN_EDIT_INTERVAL) {
      await this.sendOrEdit();
    } else if (!this.pendingEdit) {
      // Schedule edit after remaining interval
      const remaining = ToolStreamNotifier.MIN_EDIT_INTERVAL - elapsed;
      this.pendingEdit = setTimeout(async () => {
        this.pendingEdit = null;
        await this.sendOrEdit();
      }, remaining);
    }
  }

  private async sendOrEdit(): Promise<void> {
    const text = this.buildMessage();
    const bot = getTelegramBot();
    if (!bot?.api) return;

    try {
      if (!this.messageId) {
        const msg = await bot.api.sendMessage(this.userId, text);
        this.messageId = msg.message_id;
      } else {
        await bot.api.editMessageText(this.userId, this.messageId, text);
      }
      this.lastEditTime = Date.now();
    } catch (error) {
      // "message is not modified" is expected when text hasn't changed
      const msg = (error as Error).message || "";
      if (!msg.includes("not modified")) {
        console.error("[ToolStreamNotifier]", msg.slice(0, 80));
      }
    }
  }
}

// Tool status message lookup (exact match)
type StatusHandler = (i: Record<string, unknown>) => string;
const TOOL_STATUS: Map<string, StatusHandler> = new Map([
  ["WebSearch", (i) => `🔍 Web'de araştırma yapıyorum: "${i.query || ""}"`],
  ["WebFetch", () => `🌐 Web sayfasını okuyorum...`],
  ["Read", (i) => `📄 Dosya okuyorum: ${(i.file_path as string || "").split("/").pop()}`],
  ["Write", (i) => `✍️ Dosya yazıyorum: ${(i.file_path as string || "").split("/").pop()}`],
  ["Edit", (i) => `📝 Dosya düzenliyorum: ${(i.file_path as string || "").split("/").pop()}`],
  ["Bash", (i) => {
    const desc = i.description as string | undefined;
    const cmd = (i.command as string || "").slice(0, 120);
    return desc ? `⚡ ${desc}` : `⚡ ${cmd}`;
  }],
  ["Glob", (i) => `🔎 Dosya arıyorum: ${i.pattern}`],
  ["Grep", (i) => `🔍 İçerik arıyorum: "${(i.pattern as string || "").slice(0, 50)}"`],
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
  ["gateway__call", (i) => `🔌 ${i.service || "?"}/${i.tool || "?"}`],
];

export function getToolStatusMessage(name: string, input: Record<string, unknown>): string {
  const exact = TOOL_STATUS.get(name);
  if (exact) return exact(input);
  for (const [pattern, handler] of TOOL_STATUS_PATTERN) {
    if (name.includes(pattern)) return handler(input);
  }
  // Silent: gateway management (not call), telegram (avoid loops), SDK internals
  if (
    (name.includes("gateway__") && !name.includes("gateway__call")) ||
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
  notifier: ToolStreamNotifier;
}) {
  const { userId, toolsUsed, traceId, permissionMode, notifier } = params;

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

          // Stream status to single Telegram message
          try {
            const statusMessage = getToolStatusMessage(toolName, toolInput);
            if (statusMessage) {
              await notifier.append(statusMessage);
            }
          } catch (error) {
            console.error("[Cortex] Failed to append status:", error);
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

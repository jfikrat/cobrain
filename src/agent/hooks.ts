/**
 * Agent hooks — PreToolUse (logging, permissions)
 * Extracted from chat.ts for modularity
 */

import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getTelegramBot } from "./tools/telegram.ts";
import { needsPermission, askToolPermission, type PermissionMode } from "./permissions.ts";
import { config } from "../config.ts";
import { DEFAULT_TIMEZONE, DEFAULT_LOCALE, TELEGRAM_MAX_MSG_LENGTH, TELEGRAM_MIN_EDIT_INTERVAL_MS } from "../constants.ts";
import { getEventStore } from "../brain/event-store.ts";
import { userManager } from "../services/user-manager.ts";

// ========== Tool Stream Notifier ==========
// Streams tool status into a single Telegram message (edit-in-place)

export class ToolStreamNotifier {
  private messageId: number | null = null;
  private lines: string[] = [];
  private userId: number;
  private chatId: number;        // DM → same as userId; Hub topic → group chat ID
  private threadId?: number;     // Forum topic thread ID
  private lastEditTime = 0;
  private pendingEdit: Timer | null = null;
  private startTime = Date.now();
  private toolCount = 0;

  private static readonly MIN_EDIT_INTERVAL = TELEGRAM_MIN_EDIT_INTERVAL_MS;
  private static readonly MAX_MSG_LENGTH = TELEGRAM_MAX_MSG_LENGTH;
  private header: string;

  constructor(userId: number, chatId?: number, threadId?: number, agentName?: string) {
    this.userId = userId;
    this.chatId = chatId ?? userId;
    this.threadId = threadId;
    this.header = agentName ? `🧠 ${agentName} working...` : "🧠 Cortex working...";
  }

  async append(line: string): Promise<void> {
    this.toolCount++;
    const ts = new Date().toLocaleTimeString(DEFAULT_LOCALE, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: DEFAULT_TIMEZONE,
    });
    this.lines.push(`${ts} ${line}`);
    await this.flush();
  }

  async complete(opts: { cost?: number; error?: string; stopReason?: string | null } = {}): Promise<void> {
    if (this.toolCount === 0) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);

    if (opts.error) {
      this.lines.push(`\n❌ Error: ${opts.error.slice(0, 200)}`);
    } else {
      const costStr = opts.cost ? `, $${opts.cost.toFixed(3)}` : "";
      const stopWarning = opts.stopReason && opts.stopReason !== "end_turn"
        ? `\n⚠️ ${opts.stopReason === "max_tokens" ? "Response truncated due to token limit" : `Stop reason: ${opts.stopReason}`}`
        : "";
      this.lines.push(`\n✅ Done (${this.toolCount} tool, ${elapsed}s${costStr})${stopWarning}`);
    }

    // Force flush (ignore rate limit)
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
    await this.sendOrEdit();
  }

  private buildMessage(): string {
    let text = this.header + "\n\n" + this.lines.join("\n");

    // Trim oldest lines if exceeding Telegram limit
    while (text.length > ToolStreamNotifier.MAX_MSG_LENGTH && this.lines.length > 2) {
      this.lines.shift();
      text = this.header + "\n\n...\n" + this.lines.join("\n");
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
        const msg = await bot.api.sendMessage(
          this.chatId,
          text,
          this.threadId ? { message_thread_id: this.threadId } : {},
        );
        this.messageId = msg.message_id;
      } else {
        await bot.api.editMessageText(this.chatId, this.messageId, text);
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
  ["WebSearch", (i) => `🔍 Searching: "${i.query || ""}"`],
  ["WebFetch", () => `🌐 Reading web page...`],
  ["Read", (i) => `📄 Reading: ${(i.file_path as string || "").split("/").pop()}`],
  ["Write", (i) => `✍️ Writing: ${(i.file_path as string || "").split("/").pop()}`],
  ["Edit", (i) => `📝 Editing: ${(i.file_path as string || "").split("/").pop()}`],
  ["Bash", (i) => {
    const desc = i.description as string | undefined;
    const cmd = (i.command as string || "").slice(0, 120);
    return desc ? `⚡ ${desc}` : `⚡ ${cmd}`;
  }],
  ["Glob", (i) => `🔎 Finding files: ${i.pattern}`],
  ["Grep", (i) => `🔍 Searching content: "${(i.pattern as string || "").slice(0, 50)}"`],
  ["mcp__memory__remember", () => `🧠 Saving to memory...`],
  ["mcp__memory__recall", (i) => `🧠 Searching memory: "${i.query}"`],
  ["Task", (i) => `🚀 Launching sub-agent: ${i.description}`],
  ["TodoWrite", () => `📋 Updating task list...`],
]);

// Tool status message lookup (pattern/includes match)
const TOOL_STATUS_PATTERN: [string, StatusHandler][] = [
  ["gdrive_list", () => `📁 Scanning Google Drive...`],
  ["gdrive_search", () => `📁 Scanning Google Drive...`],
  ["gdrive_dirs", () => `📁 Scanning Google Drive...`],
  ["gdrive_link", () => `📁 Getting Drive file info...`],
  ["gdrive_info", () => `📁 Getting Drive file info...`],
  ["calendar_today", () => `📅 Checking today's schedule...`],
  ["calendar_agenda", () => `📅 Checking calendar...`],
  ["calendar_search", () => `🔍 Searching calendar events...`],
  ["calendar_add", () => `📅 Adding calendar event...`],
  ["squad_codex", () => `🤖 Analyzing with Codex...`],
  ["squad_gemini", () => `🤖 Generating with Gemini...`],
  ["squad_claude", () => `🤖 Consulting Claude Code...`],
  ["helm_browser_navigate", () => `🌐 Navigating to page...`],
  ["helm_browser_screenshot", () => `📸 Taking screenshot...`],
  ["helm_browser_click", () => `👆 Clicking element...`],
  ["helm_browser_type", () => `⌨️ Typing text...`],
  ["whatsapp_send_message", () => `💬 Sending WhatsApp message...`],
  ["whatsapp_get_messages", () => `💬 Reading WhatsApp messages...`],
  ["whatsapp_get_chats", () => `💬 Listing WhatsApp chats...`],
  ["whatsapp_get_contacts", () => `📇 Searching WhatsApp contacts...`],
  ["gmail_inbox", () => `📬 Checking Gmail inbox...`],
  ["gmail_search", (i) => `🔍 Searching Gmail: "${(i.query as string || "").slice(0, 30)}"`],
  ["gmail_read", () => `📧 Reading email...`],
  ["gmail_send", (i) => `📤 Sending email: "${i.subject}"`],
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
  return `🔧 Using ${name}...`;
}

/**
 * Create PreToolUse hooks for the agent query
 */
export function createPreToolUseHooks(params: {
  userId: number;
  toolsUsed: string[];
  traceId?: string;
  permissionMode: string;
  notifier: ToolStreamNotifier | null;
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

          // Stream status to single Telegram message (skip if silent/null)
          if (notifier) {
            try {
              const statusMessage = getToolStatusMessage(toolName, toolInput);
              if (statusMessage) {
                await notifier.append(statusMessage);
              }
            } catch (error) {
              console.error("[Cortex] Failed to append status:", error);
            }
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
                  permissionDecisionReason: result.message || "Denied by user",
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

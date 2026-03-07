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
import { t } from "../i18n/index.ts";

// ========== Tool Stream Notifier ==========
// Streams tool status into a single Telegram message (edit-in-place)

export class ToolStreamNotifier {
  private messageId: number | null = null;
  private lines: string[] = [];
  private userId: number;
  private chatId: number;
  private threadId?: number;
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
    this.header = agentName
      ? t("notifier.agent_working", { name: agentName })
      : t("notifier.cortex_working");
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
      this.lines.push(`\n${t("notifier.error", { message: opts.error.slice(0, 200) })}`);
    } else {
      const costStr = opts.cost ? `, $${opts.cost.toFixed(3)}` : "";
      const stopWarning = opts.stopReason && opts.stopReason !== "end_turn"
        ? `\n⚠️ ${opts.stopReason === "max_tokens" ? t("notifier.truncated") : t("notifier.stop_reason", { reason: opts.stopReason })}`
        : "";
      this.lines.push(`\n${t("notifier.done", { count: this.toolCount, elapsed, cost: costStr })}${stopWarning}`);
    }

    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
    await this.sendOrEdit();
  }

  private buildMessage(): string {
    let text = this.header + "\n\n" + this.lines.join("\n");
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
          this.chatId, text,
          this.threadId ? { message_thread_id: this.threadId } : {},
        );
        this.messageId = msg.message_id;
      } else {
        await bot.api.editMessageText(this.chatId, this.messageId, text);
      }
      this.lastEditTime = Date.now();
    } catch (error) {
      const msg = (error as Error).message || "";
      if (!msg.includes("not modified")) {
        console.error("[ToolStreamNotifier]", msg.slice(0, 80));
      }
    }
  }
}

// ── Tool status message lookup ──

type StatusHandler = (i: Record<string, unknown>) => string;

const TOOL_STATUS: Map<string, (i: Record<string, unknown>) => string> = new Map([
  ["WebSearch", (i) => t("tool.web_search", { query: String(i.query || "") })],
  ["WebFetch", () => t("tool.web_fetch")],
  ["Read", (i) => t("tool.read", { file: (i.file_path as string || "").split("/").pop() || "" })],
  ["Write", (i) => t("tool.write", { file: (i.file_path as string || "").split("/").pop() || "" })],
  ["Edit", (i) => t("tool.edit", { file: (i.file_path as string || "").split("/").pop() || "" })],
  ["Bash", (i) => {
    const desc = i.description as string | undefined;
    const cmd = (i.command as string || "").slice(0, 120);
    return desc ? `⚡ ${desc}` : `⚡ ${cmd}`;
  }],
  ["Glob", (i) => t("tool.glob", { pattern: String(i.pattern || "") })],
  ["Grep", (i) => t("tool.grep", { pattern: (i.pattern as string || "").slice(0, 50) })],
  ["mcp__memory__remember", () => t("tool.memory_save")],
  ["mcp__memory__recall", (i) => t("tool.memory_search", { query: String(i.query || "") })],
  ["Task", (i) => t("tool.sub_agent", { description: String(i.description || "") })],
  ["TodoWrite", () => t("tool.todo")],
]);

const TOOL_STATUS_PATTERN: [string, StatusHandler][] = [
  ["gdrive_list", () => t("tool.gdrive_scan")],
  ["gdrive_search", () => t("tool.gdrive_scan")],
  ["gdrive_dirs", () => t("tool.gdrive_scan")],
  ["gdrive_link", () => t("tool.gdrive_info")],
  ["gdrive_info", () => t("tool.gdrive_info")],
  ["calendar_today", () => t("tool.calendar_today")],
  ["calendar_agenda", () => t("tool.calendar_check")],
  ["calendar_search", () => t("tool.calendar_search")],
  ["calendar_add", () => t("tool.calendar_add")],
  ["squad_codex", () => t("tool.codex")],
  ["squad_gemini", () => t("tool.gemini")],
  ["squad_claude", () => t("tool.claude")],
  ["helm_browser_navigate", () => t("tool.browser_navigate")],
  ["helm_browser_screenshot", () => t("tool.browser_screenshot")],
  ["helm_browser_click", () => t("tool.browser_click")],
  ["helm_browser_type", () => t("tool.browser_type")],
  ["whatsapp_send_message", () => t("tool.wa_send")],
  ["whatsapp_get_messages", () => t("tool.wa_read")],
  ["whatsapp_get_chats", () => t("tool.wa_chats")],
  ["whatsapp_get_contacts", () => t("tool.wa_contacts")],
  ["gmail_inbox", () => t("tool.gmail_inbox")],
  ["gmail_search", (i) => t("tool.gmail_search", { query: (i.query as string || "").slice(0, 30) })],
  ["gmail_read", () => t("tool.gmail_read")],
  ["gmail_send", (i) => t("tool.gmail_send", { subject: String(i.subject || "") })],
  ["gateway__call", (i) => t("tool.gateway_call", { service: String(i.service || "?"), tool: String(i.tool || "?") })],
];

export function getToolStatusMessage(name: string, input: Record<string, unknown>): string {
  const exact = TOOL_STATUS.get(name);
  if (exact) return exact(input);
  for (const [pattern, handler] of TOOL_STATUS_PATTERN) {
    if (name.includes(pattern)) return handler(input);
  }
  if (
    (name.includes("gateway__") && !name.includes("gateway__call")) ||
    name.startsWith("telegram_") ||
    name.startsWith("mcp__telegram_") ||
    name === "AskUserQuestion" ||
    name === "EnterPlanMode" ||
    name === "ExitPlanMode"
  ) return "";
  return t("tool.fallback", { name });
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

          if (config.FF_BRAIN_EVENTS && traceId) {
            const eventStore = getEventStore();
            if (eventStore) {
              eventStore.append({
                userId, traceId,
                eventType: "agent.tool.called",
                actor: "agent",
                payload: { tool: toolName },
              });
            }
          }

          if (notifier) {
            try {
              const statusMessage = getToolStatusMessage(toolName, toolInput);
              if (statusMessage) await notifier.append(statusMessage);
            } catch (error) {
              console.error("[Cortex] Failed to append status:", error);
            }
          }

          const mode = permissionMode as PermissionMode;

          if (needsPermission(mode, toolName, toolInput)) {
            console.log(`[Cortex] Asking permission for ${toolName}...`);
            const abortController = new AbortController();
            const result = await askToolPermission(userId, toolName, toolInput, abortController.signal);

            if (result.behavior === "deny") {
              console.log(`[Cortex] Permission denied for ${toolName}`);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: result.message || t("perm.denied_by_user"),
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

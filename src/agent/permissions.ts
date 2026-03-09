/**
 * Cobrain Permission System
 * Telegram-based tool approval for dangerous operations
 */

import type { Bot } from "grammy";
import { t } from "../i18n/index.ts";

export type PermissionMode = "strict" | "smart" | "yolo";

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[rf]+\s+)?/i,
  /\brmdir\b/i,
  /\bdelete\b/i,
  /\bdrop\s+(table|database)/i,
  /\btruncate\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\//i,
  /\bchmod\s+777\b/i,
  /\bchown\b.*:.*\//i,
  /\bsudo\b/i,
  /\bkill\s+-9\b/i,
  /\bpkill\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\brclone\s+(delete|purge|move)/i,
];

const DANGEROUS_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Task"]);

// MCP tools that are safe to auto-allow in smart mode (read-only / non-destructive)
const SAFE_MCP_PATTERNS = [
  "memory",     // memory read/write (core function)
  "search",     // search operations
  "list",       // listing operations
  "read",       // read operations
  "get",        // get/fetch operations
  "status",     // status checks
  "health",     // health checks
  "tools",      // list available tools
  "services",   // list services
  "recall",     // memory recall
];

function isSafeMcpTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return SAFE_MCP_PATTERNS.some((p) => lower.includes(p));
}

interface PendingPermission {
  resolve: (allowed: boolean) => void;
  reject: (error: Error) => void;
  userId: number;
  toolName: string;
  input: unknown;
  messageId?: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const pendingPermissions = new Map<string, PendingPermission>();
let telegramBot: Bot | null = null;

export function initPermissions(bot: Bot): void {
  telegramBot = bot;
  bot.callbackQuery(/^perm:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const handled = await handlePermissionCallback(data);
    if (handled) {
      await ctx.answerCallbackQuery("✓");
    } else {
      await ctx.answerCallbackQuery(t("perm.timeout_invalid"));
    }
  });
  console.log("[Permissions] Telegram permission system initialized");
}

function isDangerousBash(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

export function needsPermission(mode: PermissionMode, toolName: string, input: unknown): boolean {
  if (mode === "yolo") return false;
  if (toolName.startsWith("mcp__")) {
    if (mode === "strict") return !toolName.includes("memory");
    // smart: safe MCP tools auto-allow, dangerous ones need permission
    if (mode === "smart") return !isSafeMcpTool(toolName);
    return false; // yolo
  }
  if (SAFE_TOOLS.has(toolName)) return false;
  if (mode === "strict") return true;
  if (mode === "smart") {
    if (toolName === "Bash") {
      const command = (input as { command?: string })?.command || "";
      return isDangerousBash(command);
    }
    if (DANGEROUS_TOOLS.has(toolName)) {
      const filePath = (input as { file_path?: string })?.file_path || "";
      if (
        filePath.startsWith("/etc/") || filePath.startsWith("/usr/") ||
        filePath.startsWith("/bin/") || filePath.startsWith("/sbin/") ||
        filePath.includes(".env") || filePath.includes("credentials") || filePath.includes("secret")
      ) return true;
      return false;
    }
    return false;
  }
  return false;
}

function formatToolInput(toolName: string, input: unknown): string {
  if (toolName === "Bash") {
    const cmd = (input as { command?: string })?.command || "";
    return `\`\`\`\n${cmd}\n\`\`\``;
  }
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = (input as { file_path?: string })?.file_path || "";
    return `${t("perm.file")}: \`${filePath}\``;
  }
  const str = JSON.stringify(input, null, 2);
  if (str.length > 300) return `\`\`\`json\n${str.slice(0, 300)}...\n\`\`\``;
  return `\`\`\`json\n${str}\n\`\`\``;
}

export async function askToolPermission(
  userId: number, toolName: string, input: unknown,
  signal: AbortSignal, timeoutMs: number = 120000
): Promise<{ behavior: "allow" | "deny"; message?: string }> {
  if (!telegramBot) {
    console.warn("[Permissions] Bot not initialized, auto-denying");
    return { behavior: "deny", message: "Permission system not initialized" };
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const description = formatToolInput(toolName, input);

  return new Promise(async (resolve, reject) => {
    try {
      const message = await telegramBot!.api.sendMessage(
        userId,
        `${t("perm.required")}\n\n*${toolName}*\n${description}\n\n${t("perm.respond_within")}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: t("perm.approve"), callback_data: `perm:${requestId}:allow` },
                { text: t("perm.deny"), callback_data: `perm:${requestId}:deny` },
              ],
              [
                { text: t("perm.deny_all"), callback_data: `perm:${requestId}:deny_all` },
              ],
            ],
          },
        }
      );

      const timeoutId = setTimeout(() => {
        if (pendingPermissions.has(requestId)) {
          pendingPermissions.delete(requestId);
          telegramBot!.api.editMessageText(
            userId, message.message_id,
            `${t("perm.title")}\n\n*${toolName}*\n${description}\n\n${t("perm.timeout_denied")}`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
          resolve({ behavior: "deny", message: "Timeout" });
        }
      }, timeoutMs);

      pendingPermissions.set(requestId, {
        resolve: (allowed) => {
          clearTimeout(timeoutId);
          telegramBot!.api.editMessageText(
            userId, message.message_id,
            `${t("perm.title")}\n\n*${toolName}*\n${description}\n\n${allowed ? t("perm.approved") : t("perm.denied")}`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
          resolve({ behavior: allowed ? "allow" : "deny" });
        },
        reject, userId, toolName, input,
        messageId: message.message_id, timeoutId,
      });

      signal.addEventListener("abort", () => {
        if (pendingPermissions.has(requestId)) {
          clearTimeout(timeoutId);
          pendingPermissions.delete(requestId);
          resolve({ behavior: "deny", message: "Aborted" });
        }
      });
    } catch (error) {
      console.error("[Permissions] Failed to send permission request:", error);
      resolve({ behavior: "deny", message: "Failed to send request" });
    }
  });
}

async function handlePermissionCallback(callbackData: string): Promise<boolean> {
  const parts = callbackData.split(":");
  if (parts.length < 3) return false;
  const requestId = parts[1];
  const decision = parts[2];
  if (!requestId) return false;
  const pending = pendingPermissions.get(requestId);
  if (!pending) return false;
  pendingPermissions.delete(requestId);
  pending.resolve(decision === "allow");
  return true;
}

export function getPendingCount(): number {
  return pendingPermissions.size;
}

export function clearAllPending(): void {
  for (const [, pending] of pendingPermissions) {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    pending.resolve(false);
  }
  pendingPermissions.clear();
}

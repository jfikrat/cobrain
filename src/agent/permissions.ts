/**
 * Cobrain Permission System
 * Telegram-based tool approval for dangerous operations
 */

import type { Bot } from "grammy";

export type PermissionMode = "strict" | "smart" | "yolo";

// Dangerous commands
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[rf]+\s+)?/i,           // rm, rm -rf
  /\brmdir\b/i,                      // rmdir
  /\bdelete\b/i,                     // delete
  /\bdrop\s+(table|database)/i,      // SQL drop
  /\btruncate\b/i,                   // SQL truncate
  /\bmkfs\b/i,                       // format disk
  /\bdd\s+if=/i,                     // dd (disk operations)
  />\s*\/dev\//i,                    // write to device
  /\bchmod\s+777\b/i,                // dangerous permissions
  /\bchown\b.*:.*\//i,               // change ownership
  /\bsudo\b/i,                       // sudo commands
  /\bkill\s+-9\b/i,                  // force kill
  /\bpkill\b/i,                      // process kill
  /\breboot\b/i,                     // reboot
  /\bshutdown\b/i,                   // shutdown
  /\brclone\s+(delete|purge|move)/i, // rclone destructive
];

// Dangerous tools
const DANGEROUS_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

// Safe tools (always auto-approve)
const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
]);

// Pending permission requests
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

// Bot reference (set during init)
let telegramBot: Bot | null = null;

/**
 * Initialize permission system with Telegram bot
 */
export function initPermissions(bot: Bot): void {
  telegramBot = bot;

  // Handle permission callbacks
  bot.callbackQuery(/^perm:/, async (ctx) => {
    console.log(`[Permissions] Callback received: ${ctx.callbackQuery.data}`);
    const data = ctx.callbackQuery.data;
    const handled = await handlePermissionCallback(data);

    console.log(`[Permissions] Callback handled: ${handled}`);

    if (handled) {
      await ctx.answerCallbackQuery("✓");
    } else {
      await ctx.answerCallbackQuery("Timeout or invalid request");
    }
  });

  console.log("[Permissions] Telegram permission system initialized");
}

/**
 * Check if a Bash command is dangerous
 */
function isDangerousBash(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Check if tool needs permission based on mode
 */
export function needsPermission(
  mode: PermissionMode,
  toolName: string,
  input: unknown
): boolean {
  // YOLO mode - never ask
  if (mode === "yolo") {
    return false;
  }

  // MCP tools - check based on mode
  if (toolName.startsWith("mcp__")) {
    // In strict mode, ask for all MCP tools except memory
    if (mode === "strict") {
      return !toolName.includes("memory");
    }
    return false; // Smart mode: MCP tools are safe
  }

  // Safe tools - never ask
  if (SAFE_TOOLS.has(toolName)) {
    return false;
  }

  // Strict mode - ask for everything except safe tools
  if (mode === "strict") {
    return true;
  }

  // Smart mode - check if dangerous
  if (mode === "smart") {
    // Bash - check command content
    if (toolName === "Bash") {
      const command = (input as { command?: string })?.command || "";
      return isDangerousBash(command);
    }

    // Write/Edit to sensitive paths
    if (DANGEROUS_TOOLS.has(toolName)) {
      const filePath = (input as { file_path?: string })?.file_path || "";
      // Sensitive paths
      if (
        filePath.startsWith("/etc/") ||
        filePath.startsWith("/usr/") ||
        filePath.startsWith("/bin/") ||
        filePath.startsWith("/sbin/") ||
        filePath.includes(".env") ||
        filePath.includes("credentials") ||
        filePath.includes("secret")
      ) {
        return true;
      }
      return false; // Normal file operations are OK
    }

    return false;
  }

  return false;
}

/**
 * Format tool input for display
 */
function formatToolInput(toolName: string, input: unknown): string {
  if (toolName === "Bash") {
    const cmd = (input as { command?: string })?.command || "";
    return `\`\`\`\n${cmd}\n\`\`\``;
  }

  if (toolName === "Write" || toolName === "Edit") {
    const filePath = (input as { file_path?: string })?.file_path || "";
    return `File: \`${filePath}\``;
  }

  // Generic
  const str = JSON.stringify(input, null, 2);
  if (str.length > 300) {
    return `\`\`\`json\n${str.slice(0, 300)}...\n\`\`\``;
  }
  return `\`\`\`json\n${str}\n\`\`\``;
}

/**
 * Ask user for tool permission via Telegram
 */
export async function askToolPermission(
  userId: number,
  toolName: string,
  input: unknown,
  signal: AbortSignal,
  timeoutMs: number = 120000
): Promise<{ behavior: "allow" | "deny"; message?: string }> {
  if (!telegramBot) {
    console.warn("[Permissions] Bot not initialized, auto-denying");
    return { behavior: "deny", message: "Permission system not initialized" };
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const description = formatToolInput(toolName, input);

  return new Promise(async (resolve, reject) => {
    try {
      console.log(`[Permissions] Sending permission request to user ${userId} for ${toolName}`);

      // Send Telegram message with buttons
      const message = await telegramBot!.api.sendMessage(
        userId,
        `🔐 *Tool Approval Required*\n\n` +
          `*${toolName}*\n${description}\n\n` +
          `_Respond within 2 minutes_`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `perm:${requestId}:allow` },
                { text: "❌ Deny", callback_data: `perm:${requestId}:deny` },
              ],
              [
                { text: "🚫 Deny All", callback_data: `perm:${requestId}:deny_all` },
              ],
            ],
          },
        }
      );

      console.log(`[Permissions] Message sent: ${message.message_id}`);

      // Timeout
      const timeoutId = setTimeout(() => {
        if (pendingPermissions.has(requestId)) {
          pendingPermissions.delete(requestId);

          // Update message
          telegramBot!.api
            .editMessageText(
              userId,
              message.message_id,
              `🔐 *Tool Approval*\n\n*${toolName}*\n${description}\n\n⏱️ _Timeout - Denied_`,
              { parse_mode: "Markdown" }
            )
            .catch(() => {});

          resolve({ behavior: "deny", message: "Timeout" });
        }
      }, timeoutMs);

      // Store pending request
      pendingPermissions.set(requestId, {
        resolve: (allowed) => {
          clearTimeout(timeoutId);

          // Update message
          telegramBot!.api
            .editMessageText(
              userId,
              message.message_id,
              `🔐 *Tool Approval*\n\n*${toolName}*\n${description}\n\n${allowed ? "✅ _Approved_" : "❌ _Denied_"}`,
              { parse_mode: "Markdown" }
            )
            .catch(() => {});

          resolve({ behavior: allowed ? "allow" : "deny" });
        },
        reject,
        userId,
        toolName,
        input,
        messageId: message.message_id,
        timeoutId,
      });

      // Handle abort
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

/**
 * Handle permission callback from Telegram button
 */
async function handlePermissionCallback(callbackData: string): Promise<boolean> {
  const parts = callbackData.split(":");
  if (parts.length < 3) return false;

  const requestId = parts[1];
  const decision = parts[2];

  if (!requestId) return false;

  const pending = pendingPermissions.get(requestId);

  if (!pending) {
    return false;
  }

  pendingPermissions.delete(requestId);

  if (decision === "allow") {
    pending.resolve(true);
  } else {
    pending.resolve(false);
  }

  return true;
}

/**
 * Get pending permissions count
 */
export function getPendingCount(): number {
  return pendingPermissions.size;
}

/**
 * Clear all pending permissions (on shutdown)
 */
export function clearAllPending(): void {
  for (const [, pending] of pendingPermissions) {
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    pending.resolve(false);
  }
  pendingPermissions.clear();
}

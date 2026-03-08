// Global fatal error handlers — must be first, before any imports/initialization
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  // Don't exit — let systemd restart handle it if needed
  // Most unhandled rejections are recoverable
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
  // Give time to flush logs, then exit with error code
  // systemd will restart the service
  setTimeout(() => process.exit(1), 1000);
});

/**
 * Cobrain Entry Point
 * Routes between setup mode and normal mode based on config validity
 */

import { loadConfigSafe } from "./config.ts";

const configResult = loadConfigSafe();

if (!configResult.success) {
  console.error(`
  [FATAL] Configuration missing or invalid.

  Errors:
${configResult.errors.map((e) => `    • ${e}`).join("\n")}

  Fix your .env file and restart.
  Required: TELEGRAM_BOT_TOKEN, MY_TELEGRAM_ID
  `);
  process.exit(1);
} else {
  // Normal mode - config is valid
  import("./startup.ts");
}

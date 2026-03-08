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
  // Setup mode - config is missing or invalid
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║                                                           ║
  ║     ██████╗ ██████╗ ██████╗ ██████╗  █████╗ ██╗███╗   ██╗ ║
  ║    ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██║████╗  ██║ ║
  ║    ██║     ██║   ██║██████╔╝██████╔╝███████║██║██╔██╗ ██║ ║
  ║    ██║     ██║   ██║██╔══██╗██╔══██╗██╔══██║██║██║╚██╗██║ ║
  ║    ╚██████╗╚██████╔╝██████╔╝██║  ██║██║  ██║██║██║ ╚████║ ║
  ║     ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝ ║
  ║                                                           ║
  ║                    SETUP MODE                           ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝

  Configuration missing or invalid.

  Errors:
${configResult.errors.map((e) => `    • ${e}`).join("\n")}

  Open the setup wizard:
  → http://localhost:3000
  `);

  // Start setup server
  import("./web/setup-server.ts").then((m) => m.startSetupServer());
} else {
  // Normal mode - config is valid
  import("./startup.ts");
}

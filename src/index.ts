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
  ║                    KURULUM MODU                           ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝

  Konfigürasyon eksik veya geçersiz.

  Hatalar:
${configResult.errors.map((e) => `    • ${e}`).join("\n")}

  Kurulum sihirbazını açın:
  → http://localhost:3000
  `);

  // Start setup server
  import("./web/setup-server.ts").then((m) => m.startSetupServer());
} else {
  // Normal mode - config is valid
  import("./startup.ts");
}

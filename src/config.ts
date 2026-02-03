import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

const envSchema = z.object({
  // Core
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Telegram bot token gerekli"),
  ALLOWED_USER_IDS: z.string().transform((val) =>
    val.split(",").map((id) => parseInt(id.trim(), 10))
  ),
  MAX_HISTORY: z.coerce.number().default(10),

  // v0.2: Per-user folders
  COBRAIN_BASE_PATH: z.string().default(join(homedir(), ".cobrain")),

  // v0.2: Memory settings
  MAX_MEMORY_AGE_DAYS: z.coerce.number().default(90),

  // v0.2: Autonomous features
  ENABLE_AUTONOMOUS: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  // v0.3: Agent SDK mode (vs CLI mode)
  USE_AGENT_SDK: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  // v0.3: Permission mode for tool approval
  // strict = ask for everything, smart = ask for dangerous only, yolo = auto-approve all
  PERMISSION_MODE: z
    .enum(["strict", "smart", "yolo"])
    .default("smart"),

  // v0.4: Web UI
  WEB_PORT: z.coerce.number().default(3000),
  WEB_URL: z.string().default("http://localhost:3000"),
  ENABLE_WEB_UI: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  // v0.5: Gemini API (for voice transcription)
  GEMINI_API_KEY: z.string().default(""),
  TRANSCRIPTION_MODEL: z.string().default("gemini-3-flash-preview"),

  // v0.6: Agent model
  AGENT_MODEL: z.string().default("claude-opus-4-20250514"),
  MAX_AGENT_TURNS: z.coerce.number().default(20),

  // Legacy (kept for migration)
  DB_PATH: z.string().default("./data/cobrain.db"),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Konfigürasyon hatası:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;

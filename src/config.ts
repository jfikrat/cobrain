import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

const envSchema = z.object({
  // Core
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Telegram bot token gerekli"),
  MY_TELEGRAM_ID: z.coerce.number().min(1, "Telegram user ID gerekli"),
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

  // v0.6: Gmail OAuth2
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GMAIL_REDIRECT_URI: z.string().default(""),

  // v0.6: Agent model
  AGENT_MODEL: z.string().default("claude-opus-4-6"),
  MAX_AGENT_TURNS: z.coerce.number().default(20),

  // v0.7: Always-on heartbeat monitoring
  ENABLE_HEARTBEAT_MONITORING: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  HEARTBEAT_STALE_AFTER_MS: z.coerce.number().default(120_000),
  HEARTBEAT_LOG_INTERVAL_MS: z.coerce.number().default(30_000),

  // Legacy (kept for migration)
  DB_PATH: z.string().default("./data/cobrain.db"),
});

// Type for safe config loading result
export type ConfigResult =
  | { success: true; data: Config }
  | { success: false; errors: string[] };

/**
 * Load config without crashing on error
 * Returns success/error state for setup wizard
 */
export function loadConfigSafe(): ConfigResult {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`
      ),
    };
  }

  return { success: true, data: result.data };
}

/**
 * Check if current config is valid
 */
export function isConfigValid(): boolean {
  return loadConfigSafe().success;
}

/**
 * Get config schema for setup wizard
 * Returns required and optional fields with descriptions
 */
export function getConfigSchema() {
  return {
    required: [
      {
        key: "TELEGRAM_BOT_TOKEN",
        label: "Telegram Bot Token",
        hint: "@BotFather'dan bot oluşturup token'ı buraya yapıştırın",
        type: "password" as const,
      },
      {
        key: "MY_TELEGRAM_ID",
        label: "Telegram User ID",
        hint: "@userinfobot'a mesaj atarak ID'nizi öğrenebilirsiniz",
        type: "text" as const,
      },
    ],
    optional: [
      {
        key: "GEMINI_API_KEY",
        label: "Gemini API Key",
        hint: "Ses mesajları için gerekli (opsiyonel)",
        type: "password" as const,
        default: "",
      },
      {
        key: "WEB_PORT",
        label: "Web Port",
        hint: "Web arayüzü portu",
        type: "text" as const,
        default: "3000",
      },
      {
        key: "AGENT_MODEL",
        label: "AI Model",
        hint: "Kullanılacak Claude modeli",
        type: "text" as const,
        default: "claude-opus-4-6",
      },
      {
        key: "GOOGLE_CLIENT_ID",
        label: "Google Client ID",
        hint: "Gmail entegrasyonu icin Google OAuth2 Client ID",
        type: "text" as const,
        default: "",
      },
      {
        key: "GOOGLE_CLIENT_SECRET",
        label: "Google Client Secret",
        hint: "Gmail entegrasyonu icin Google OAuth2 Client Secret",
        type: "password" as const,
        default: "",
      },
    ],
  };
}

// Config type derived from schema
export type Config = z.infer<typeof envSchema>;

// Export config - will throw if called before setup is complete
let _config: Config | null = null;

export const config = new Proxy({} as Config, {
  get(_, prop: string) {
    if (!_config) {
      const result = loadConfigSafe();
      if (result.success) {
        _config = result.data;
      } else {
        throw new Error(
          `Config not initialized. Errors: ${result.errors.join(", ")}`
        );
      }
    }
    return _config[prop as keyof Config];
  },
});

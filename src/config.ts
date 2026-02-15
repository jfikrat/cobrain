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

  // v0.6: Agent model
  AGENT_MODEL: z.string().default("claude-opus-4-6"),
  MAX_AGENT_TURNS: z.coerce.number().default(20),

  // v0.9: Brain Events — Phase 1
  FF_BRAIN_EVENTS: z.coerce.boolean().default(true),
  FF_ROUTER_LITE: z.coerce.boolean().default(true), // active — only downgrades "fast" (simple) queries
  FF_SESSION_STATE: z.coerce.boolean().default(true),
  FF_MEMORY_CONSOLIDATION: z.coerce.boolean().default(true),

  // Model cascade (router-lite)
  AGENT_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),
  AGENT_MODEL_DEFAULT: z.string().default("claude-sonnet-4-5-20250929"),
  // AGENT_MODEL is used as the "deep" path (claude-opus-4-6)

  // v0.7: Always-on heartbeat monitoring
  ENABLE_HEARTBEAT_MONITORING: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  HEARTBEAT_STALE_AFTER_MS: z.coerce.number().default(120_000),
  HEARTBEAT_LOG_INTERVAL_MS: z.coerce.number().default(30_000),

  // v0.8: WhatsApp notification settings
  WHATSAPP_STALE_MAX_AGE_SEC: z.coerce.number().default(300),
  WHATSAPP_ALLOWED_GROUP_JIDS: z.string().default(""),
  WHATSAPP_MAX_REPLY_LENGTH: z.coerce.number().default(500),

  // v1.0: REST API
  COBRAIN_API_KEY: z.string().default(""),

  // v1.1: Cortex tuning
  CORTEX_SALIENCE_THRESHOLD: z.coerce.number().default(0.3),
  CORTEX_AI_TIMEOUT_MS: z.coerce.number().default(30_000),
  CORTEX_MAX_QUEUE_SIZE: z.coerce.number().default(50),
  CORTEX_EXPECTATION_TIMEOUT_MS: z.coerce.number().default(30 * 60 * 1000),
  CORTEX_EXPECTATION_CLEANUP_INTERVAL_MS: z.coerce.number().default(60_000),
  CORTEX_MODEL: z.string().default("gemini-3-flash-preview"),

  // v1.2: Vector search
  FF_VECTOR_SEARCH: z.coerce.boolean().default(true),
  VECTOR_WEIGHT: z.coerce.number().default(0.7),
  FTS_WEIGHT: z.coerce.number().default(0.3),
  EMBEDDING_MODEL: z.string().default("text-embedding-004"),
  CHUNK_SIZE: z.coerce.number().default(400),
  CHUNK_OVERLAP: z.coerce.number().default(80),

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

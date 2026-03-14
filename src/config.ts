import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

const envSchema = z.object({
  // Core
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Telegram bot token is required"),
  MY_TELEGRAM_ID: z.coerce.number().min(1, "Telegram user ID is required"),
  MAX_HISTORY: z.coerce.number().default(10),

  // v0.2: Per-user folders
  COBRAIN_BASE_PATH: z.string().default(join(homedir(), ".cobrain")),

  // v0.2: Autonomous features
  ENABLE_AUTONOMOUS: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),

  // v0.3: Permission mode for tool approval
  // strict = ask for everything, smart = ask for dangerous only, yolo = auto-approve all
  PERMISSION_MODE: z
    .enum(["strict", "smart", "yolo"])
    .default("strict"),

  // API Server
  API_PORT: z.coerce.number().default(3000),

  // v0.5: Gemini API (for voice transcription)
  GEMINI_API_KEY: z.string().default(""),
  TRANSCRIPTION_MODEL: z.string().default("gemini-3.1-flash-lite-preview"),

  // v0.6: Agent model
  AGENT_MODEL: z.string().default("claude-opus-4-6"),
  MAX_AGENT_TURNS: z.coerce.number().default(20),

  // v0.9: Brain Events — Phase 1
  FF_BRAIN_EVENTS: z.coerce.boolean().default(true),
  FF_SESSION_STATE: z.coerce.boolean().default(true),
  FF_MEMORY_CONSOLIDATION: z.coerce.boolean().default(true),

  // v0.7: Always-on heartbeat monitoring
  ENABLE_HEARTBEAT_MONITORING: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  HEARTBEAT_STALE_AFTER_MS: z.coerce.number().default(120_000),
  HEARTBEAT_LOG_INTERVAL_MS: z.coerce.number().default(30_000),

  // v1.3: BrainLoop tick intervals and knowledge base
  BRAIN_LOOP_FAST_TICK_MS: z.coerce.number().default(5_000),
  BRAIN_LOOP_SLOW_TICK_MS: z.coerce.number().default(300_000),
  BRAIN_LOOP_KNOWLEDGE_PATH: z.string().default("knowledge"),

  // v1.0: REST API
  COBRAIN_API_KEY: z.string().default(""),

  // Log channel: autonomous event logs sent here
  LOG_CHANNEL_ID: z.coerce.number().optional(),

  // v1.5: Multi-Agent Hub (Telegram Forum Mode)
  COBRAIN_HUB_ID: z.coerce.number().optional(),
});

// Type for safe config loading result
export type ConfigResult =
  | { success: true; data: Config }
  | { success: false; errors: string[] };

/**
 * Load config without throwing on validation errors.
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

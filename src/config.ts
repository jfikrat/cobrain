import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Telegram bot token gerekli"),
  ALLOWED_USER_IDS: z.string().transform((val) =>
    val.split(",").map((id) => parseInt(id.trim(), 10))
  ),
  MAX_HISTORY: z.coerce.number().default(10),
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

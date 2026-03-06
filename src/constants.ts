/**
 * Merkezi sabitler — magic number'ları tek noktada toplar.
 * Davranış değişikliği yok, sadece merkezileştirme.
 */

// ── Locale & Timezone ──
export const DEFAULT_TIMEZONE = "Europe/Istanbul";
export const DEFAULT_LOCALE = "tr-TR";
export const TR_DAY_NAMES = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

// ── Active Hours ──
export const ACTIVE_HOUR_START = 7;   // 07:00
export const ACTIVE_HOUR_END = 23;    // 23:00
export const NIGHT_HOUR_START = 23;   // Gece modu başlangıcı
export const NIGHT_HOUR_END = 8;      // Gece modu sonu

// ── TTLs (ms) ──
export const DAY_MS = 24 * 60 * 60 * 1000;                       // 24 saat (genel)
export const WA_NOTIFICATION_TTL_MS = DAY_MS;                     // 24 saat (WA context)
export const REMINDER_INBOX_TTL_MS = 30 * 60 * 1000;             // 30 dk
export const EXPECTATION_INBOX_TTL_MS = 60 * 60 * 1000;          // 60 dk
export const PROACTIVE_INBOX_TTL_MS = 55 * 60 * 1000;            // 55 dk

// ── Limits ──
export const MAX_WA_NOTIFICATIONS = 10;
export const MAX_WA_CONTEXT_ITEMS = 5;

// ── Telegram ──
export const TELEGRAM_MAX_MSG_LENGTH = 4096;
export const TELEGRAM_MIN_EDIT_INTERVAL_MS = 1500;

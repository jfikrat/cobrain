/**
 * Central constants - collects magic numbers in one place.
 * No behavior changes, just centralization.
 */

// ── Locale & Timezone ──
export const DEFAULT_TIMEZONE = "Europe/Istanbul";
export const DEFAULT_LOCALE = "en-US";
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Active Hours ──
export const ACTIVE_HOUR_START = 7;   // 07:00
export const ACTIVE_HOUR_END = 23;    // 23:00
export const NIGHT_HOUR_START = 23;   // Night mode start
export const NIGHT_HOUR_END = 8;      // Night mode end

// ── TTLs (ms) ──
export const DAY_MS = 24 * 60 * 60 * 1000;                       // 24 hours (general)
export const WA_NOTIFICATION_TTL_MS = DAY_MS;                     // 24 hours (WA context)
export const REMINDER_INBOX_TTL_MS = 30 * 60 * 1000;             // 30 min
export const EXPECTATION_INBOX_TTL_MS = 60 * 60 * 1000;          // 60 min
export const PROACTIVE_INBOX_TTL_MS = 55 * 60 * 1000;            // 55 min

// ── Limits ──
export const MAX_WA_NOTIFICATIONS = 10;
export const MAX_WA_CONTEXT_ITEMS = 5;

// ── Telegram ──
export const TELEGRAM_MAX_MSG_LENGTH = 4096;
export const TELEGRAM_MIN_EDIT_INTERVAL_MS = 1500;

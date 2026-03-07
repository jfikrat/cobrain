/**
 * Cobrain i18n — simple key-value translation system
 * Locale is set once at startup, changed via /lang command.
 */

import { en } from "./en.ts";
import { tr } from "./tr.ts";

export type Locale = "en" | "tr";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  tr: "Türkçe",
};

const locales: Record<Locale, Record<string, string>> = { en, tr };

let currentLocale: Locale = "en";

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locales[locale]) {
    currentLocale = locale;
  }
}

/**
 * Translate a key with optional parameter interpolation.
 * Falls back to English, then to the raw key.
 *
 * Usage: t("notifier.agent_working", { name: "WhatsApp" })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let str = locales[currentLocale]?.[key] || en[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}

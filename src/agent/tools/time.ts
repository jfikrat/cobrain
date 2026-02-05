/**
 * Time Tools for Cobrain Agent
 * MCP tools for date/time operations
 * Shared server (not user-specific)
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";

// Default settings
const DEFAULT_TIMEZONE = "Europe/Istanbul";
const DEFAULT_LOCALE = "tr-TR";

// Valid timezones for validation (common ones)
const COMMON_TIMEZONES = [
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "UTC",
];

/**
 * Get formatted date parts for a given date and timezone
 */
function getDateInfo(date: Date, timezone: string, locale: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || "";

  // Calculate week number (ISO 8601)
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);

  // Calculate quarter
  const month = date.getMonth();
  const quarter = Math.floor(month / 3) + 1;

  // Day of year
  const dayOfYear = days + 1;

  return {
    weekday: getPart("weekday"),
    day: getPart("day"),
    month: getPart("month"),
    year: getPart("year"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    second: getPart("second"),
    weekNumber,
    quarter,
    dayOfYear,
    isWeekend: [0, 6].includes(date.getDay()),
  };
}

/**
 * Format date as relative time ("2 gün sonra", "3 saat önce")
 */
function formatRelative(date: Date, locale: string): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);
  const diffWeek = Math.round(diffDay / 7);
  const diffMonth = Math.round(diffDay / 30);
  const diffYear = Math.round(diffDay / 365);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, "hour");
  if (Math.abs(diffDay) < 7) return rtf.format(diffDay, "day");
  if (Math.abs(diffWeek) < 4) return rtf.format(diffWeek, "week");
  if (Math.abs(diffMonth) < 12) return rtf.format(diffMonth, "month");
  return rtf.format(diffYear, "year");
}

/**
 * Parse a date string flexibly
 */
function parseDate(dateStr: string): Date | null {
  // Try ISO format first
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) return isoDate;

  // Try DD.MM.YYYY format (Turkish)
  const turkishMatch = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (turkishMatch) {
    const [, day, month, year] = turkishMatch;
    return new Date(parseInt(year!), parseInt(month!) - 1, parseInt(day!));
  }

  // Try DD/MM/YYYY format
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return new Date(parseInt(year!), parseInt(month!) - 1, parseInt(day!));
  }

  return null;
}

// ========== TIME TOOLS ==========

export const getCurrentTimeTool = tool(
  "get_current_time",
  "Şu anki tarih ve saati gösterir. Timezone destekler.",
  {
    timezone: z
      .string()
      .optional()
      .describe(`Timezone (varsayılan: ${DEFAULT_TIMEZONE}). Örnekler: Europe/Istanbul, UTC, America/New_York`),
  },
  async ({ timezone }) => {
    try {
      const tz = timezone || DEFAULT_TIMEZONE;
      const now = new Date();

      const formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const formatted = formatter.format(now);
      const isoString = now.toISOString();

      return toolSuccess(`🕐 Şu an: ${formatted}\n📅 ISO: ${isoString}\n🌍 Timezone: ${tz}`);
    } catch (error) {
      return toolError("Saat alınamadı", error);
    }
  }
);

export const getDateInfoTool = tool(
  "get_date_info",
  "Belirli bir tarih hakkında detaylı bilgi verir (gün adı, hafta numarası, çeyrek, yılın kaçıncı günü).",
  {
    date: z
      .string()
      .optional()
      .describe("Tarih (YYYY-MM-DD, DD.MM.YYYY veya DD/MM/YYYY). Boş bırakılırsa bugün."),
    timezone: z.string().optional().describe(`Timezone (varsayılan: ${DEFAULT_TIMEZONE})`),
  },
  async ({ date, timezone }) => {
    try {
      const tz = timezone || DEFAULT_TIMEZONE;
      const targetDate = date ? parseDate(date) : new Date();

      if (!targetDate) {
        return toolError("Geçersiz tarih formatı", new Error(`"${date}" - YYYY-MM-DD veya DD.MM.YYYY kullanın`));
      }

      const info = getDateInfo(targetDate, tz, DEFAULT_LOCALE);

      return toolSuccess(`📅 Tarih Bilgisi:
- Gün: ${info.weekday}, ${info.day} ${info.month} ${info.year}
- Hafta: ${info.weekNumber}. hafta
- Çeyrek: Q${info.quarter}
- Yılın ${info.dayOfYear}. günü
- Hafta sonu: ${info.isWeekend ? "Evet ✓" : "Hayır"}`);
    } catch (error) {
      return toolError("Tarih bilgisi alınamadı", error);
    }
  }
);

export const calculateDateTool = tool(
  "calculate_date",
  "Bir tarihten X gün/hafta/ay sonra veya önce hangi tarih olduğunu hesaplar.",
  {
    amount: z.number().describe("Miktar (pozitif = sonra, negatif = önce)"),
    unit: z.enum(["day", "week", "month", "year"]).describe("Birim: day, week, month, year"),
    fromDate: z.string().optional().describe("Başlangıç tarihi (varsayılan: bugün)"),
  },
  async ({ amount, unit, fromDate }) => {
    try {
      const startDate = fromDate ? parseDate(fromDate) : new Date();

      if (!startDate) {
        return toolError("Geçersiz tarih formatı", new Error(`"${fromDate}"`));
      }

      const result = new Date(startDate);

      switch (unit) {
        case "day":
          result.setDate(result.getDate() + amount);
          break;
        case "week":
          result.setDate(result.getDate() + amount * 7);
          break;
        case "month":
          result.setMonth(result.getMonth() + amount);
          break;
        case "year":
          result.setFullYear(result.getFullYear() + amount);
          break;
      }

      const info = getDateInfo(result, DEFAULT_TIMEZONE, DEFAULT_LOCALE);
      const direction = amount > 0 ? "sonra" : "önce";
      const absAmount = Math.abs(amount);
      const unitTr = { day: "gün", week: "hafta", month: "ay", year: "yıl" }[unit];

      const formatted = `${info.day} ${info.month} ${info.year}, ${info.weekday}`;

      return toolSuccess(`📅 ${absAmount} ${unitTr} ${direction}:
${formatted}
ISO: ${result.toISOString().split("T")[0]}`);
    } catch (error) {
      return toolError("Tarih hesaplanamadı", error);
    }
  }
);

export const timeUntilTool = tool(
  "time_until",
  "İki tarih arasındaki farkı hesaplar. Bir tarihe kaç gün kaldığını öğrenmek için kullan.",
  {
    targetDate: z.string().describe("Hedef tarih (YYYY-MM-DD, DD.MM.YYYY veya DD/MM/YYYY)"),
    fromDate: z.string().optional().describe("Başlangıç tarihi (varsayılan: bugün)"),
  },
  async ({ targetDate, fromDate }) => {
    try {
      const target = parseDate(targetDate);
      const from = fromDate ? parseDate(fromDate) : new Date();

      if (!target) {
        return toolError("Geçersiz hedef tarih", new Error(`"${targetDate}"`));
      }

      if (!from) {
        return toolError("Geçersiz başlangıç tarihi", new Error(`"${fromDate}"`));
      }

      // Reset time parts for accurate day calculation
      const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
      const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());

      const diffMs = targetDay.getTime() - fromDay.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      const diffWeeks = Math.floor(Math.abs(diffDays) / 7);
      const remainingDays = Math.abs(diffDays) % 7;

      const targetInfo = getDateInfo(target, DEFAULT_TIMEZONE, DEFAULT_LOCALE);
      const formatted = `${targetInfo.day} ${targetInfo.month} ${targetInfo.year}, ${targetInfo.weekday}`;

      let resultText = "";
      if (diffDays === 0) {
        resultText = "🎯 Bugün!";
      } else if (diffDays > 0) {
        resultText = `⏳ ${diffDays} gün kaldı`;
        if (diffWeeks > 0) {
          resultText += ` (${diffWeeks} hafta${remainingDays > 0 ? ` ${remainingDays} gün` : ""})`;
        }
      } else {
        resultText = `📆 ${Math.abs(diffDays)} gün geçti`;
        if (diffWeeks > 0) {
          resultText += ` (${diffWeeks} hafta${remainingDays > 0 ? ` ${remainingDays} gün` : ""})`;
        }
      }

      return toolSuccess(`${resultText}
📅 Hedef: ${formatted}`);
    } catch (error) {
      return toolError("Tarih farkı hesaplanamadı", error);
    }
  }
);

export const formatDateTool = tool(
  "format_date",
  "Tarihi farklı formatlarda gösterir (relative: '2 gün sonra', long, short, ISO).",
  {
    date: z.string().describe("Tarih (YYYY-MM-DD, DD.MM.YYYY veya DD/MM/YYYY)"),
    format: z
      .enum(["relative", "long", "short", "iso"])
      .optional()
      .describe("Format tipi (varsayılan: relative)"),
    timezone: z.string().optional().describe(`Timezone (varsayılan: ${DEFAULT_TIMEZONE})`),
  },
  async ({ date, format, timezone }) => {
    try {
      const targetDate = parseDate(date);
      if (!targetDate) {
        return toolError("Geçersiz tarih", new Error(`"${date}"`));
      }

      const tz = timezone || DEFAULT_TIMEZONE;
      const fmt = format || "relative";

      let result = "";

      switch (fmt) {
        case "relative":
          result = formatRelative(targetDate, DEFAULT_LOCALE);
          break;
        case "long": {
          const formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
            timeZone: tz,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          });
          result = formatter.format(targetDate);
          break;
        }
        case "short": {
          const formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          result = formatter.format(targetDate);
          break;
        }
        case "iso":
          result = targetDate.toISOString().split("T")[0]!;
          break;
      }

      return toolSuccess(`📅 ${result}`);
    } catch (error) {
      return toolError("Tarih formatlanamadı", error);
    }
  }
);

// ========== SERVER ==========

let timeServer: ReturnType<typeof createSdkMcpServer> | null = null;

/**
 * Create Time MCP server (shared, not user-specific)
 */
export function createTimeServer() {
  return createSdkMcpServer({
    name: "cobrain-time",
    version: "1.0.0",
    tools: [getCurrentTimeTool, getDateInfoTool, calculateDateTool, timeUntilTool, formatDateTool],
  });
}

/**
 * Get or create the shared time server
 */
export function getTimeServer() {
  if (!timeServer) {
    timeServer = createTimeServer();
  }
  return timeServer;
}

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
const DEFAULT_LOCALE = "en-US";

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
 * Format date as relative time ("in 2 days", "3 hours ago")
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
  "Show the current date and time. Supports timezones.",
  {
    timezone: z
      .string()
      .optional()
      .describe(`Timezone (default: ${DEFAULT_TIMEZONE}). Examples: Europe/Istanbul, UTC, America/New_York`),
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

      return toolSuccess(`🕐 Now: ${formatted}\n📅 ISO: ${isoString}\n🌍 Timezone: ${tz}`);
    } catch (error) {
      return toolError("Could not get time", error);
    }
  }
);

export const getDateInfoTool = tool(
  "get_date_info",
  "Get detailed information about a date (weekday, week number, quarter, day of year).",
  {
    date: z
      .string()
      .optional()
      .describe("Date (YYYY-MM-DD, DD.MM.YYYY, or DD/MM/YYYY). Defaults to today if omitted."),
    timezone: z.string().optional().describe(`Timezone (default: ${DEFAULT_TIMEZONE})`),
  },
  async ({ date, timezone }) => {
    try {
      const tz = timezone || DEFAULT_TIMEZONE;
      const targetDate = date ? parseDate(date) : new Date();

      if (!targetDate) {
        return toolError("Invalid date format", new Error(`"${date}" - use YYYY-MM-DD or DD.MM.YYYY`));
      }

      const info = getDateInfo(targetDate, tz, DEFAULT_LOCALE);

      return toolSuccess(`📅 Date Info:
- Day: ${info.weekday}, ${info.day} ${info.month} ${info.year}
- Week: ${info.weekNumber}
- Quarter: Q${info.quarter}
- Day ${info.dayOfYear} of the year
- Weekend: ${info.isWeekend ? "Yes ✓" : "No"}`);
    } catch (error) {
      return toolError("Could not get date info", error);
    }
  }
);

export const calculateDateTool = tool(
  "calculate_date",
  "Calculate the date X days, weeks, months, or years after or before a given date.",
  {
    amount: z.number().describe("Amount (positive = after, negative = before)"),
    unit: z.enum(["day", "week", "month", "year"]).describe("Birim: day, week, month, year"),
    fromDate: z.string().optional().describe("Start date (default: today)"),
  },
  async ({ amount, unit, fromDate }) => {
    try {
      const startDate = fromDate ? parseDate(fromDate) : new Date();

      if (!startDate) {
        return toolError("Invalid date format", new Error(`"${fromDate}"`));
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
      const direction = amount > 0 ? "later" : "ago";
      const absAmount = Math.abs(amount);
      const unitTr = { day: "day", week: "week", month: "month", year: "year" }[unit];

      const formatted = `${info.day} ${info.month} ${info.year}, ${info.weekday}`;

      return toolSuccess(`📅 ${absAmount} ${unitTr} ${direction}:
${formatted}
ISO: ${result.toISOString().split("T")[0]}`);
    } catch (error) {
      return toolError("Could not calculate date", error);
    }
  }
);

export const timeUntilTool = tool(
  "time_until",
  "Calculate the difference between two dates. Use to find how many days remain until a date.",
  {
    targetDate: z.string().describe("Target date (YYYY-MM-DD, DD.MM.YYYY, or DD/MM/YYYY)"),
    fromDate: z.string().optional().describe("Start date (default: today)"),
  },
  async ({ targetDate, fromDate }) => {
    try {
      const target = parseDate(targetDate);
      const from = fromDate ? parseDate(fromDate) : new Date();

      if (!target) {
        return toolError("Invalid target date", new Error(`"${targetDate}"`));
      }

      if (!from) {
        return toolError("Invalid start date", new Error(`"${fromDate}"`));
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
        resultText = "🎯 Today!";
      } else if (diffDays > 0) {
        resultText = `⏳ ${diffDays} days left`;
        if (diffWeeks > 0) {
          resultText += ` (${diffWeeks} weeks${remainingDays > 0 ? ` ${remainingDays} days` : ""})`;
        }
      } else {
        resultText = `📆 ${Math.abs(diffDays)} days ago`;
        if (diffWeeks > 0) {
          resultText += ` (${diffWeeks} weeks${remainingDays > 0 ? ` ${remainingDays} days` : ""})`;
        }
      }

      return toolSuccess(`${resultText}
📅 Target: ${formatted}`);
    } catch (error) {
      return toolError("Could not calculate date difference", error);
    }
  }
);

export const formatDateTool = tool(
  "format_date",
  "Format a date in different ways (relative: 'in 2 days', long, short, ISO).",
  {
    date: z.string().describe("Date (YYYY-MM-DD, DD.MM.YYYY, or DD/MM/YYYY)"),
    format: z
      .enum(["relative", "long", "short", "iso"])
      .optional()
      .describe("Format type (default: relative)"),
    timezone: z.string().optional().describe(`Timezone (default: ${DEFAULT_TIMEZONE})`),
  },
  async ({ date, format, timezone }) => {
    try {
      const targetDate = parseDate(date);
      if (!targetDate) {
        return toolError("Invalid date", new Error(`"${date}"`));
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
      return toolError("Could not format date", error);
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

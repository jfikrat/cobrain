/**
 * Google Calendar Tools for Cobrain Agent
 * MCP tools for gcalcli-based Google Calendar operations
 * Shared server (not user-specific, OAuth stored in ~/.config/gcalcli/)
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { $ } from "bun";

/**
 * Execute gcalcli command
 */
async function gcalcli(args: string[]): Promise<{ output: string; error?: string }> {
  try {
    const result = await $`gcalcli ${args}`.quiet();
    return { output: result.stdout.toString().trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "gcalcli error";
    return { output: "", error: message };
  }
}

/**
 * Today's events
 */
export const calendarTodayTool = tool(
  "calendar_today",
  "Show today's calendar events.",
  {},
  async () => {
    const { output, error } = await gcalcli(["agenda", "--nostarted", "--details", "length"]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Calendar error: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: "No calendar events for today." }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `📅 Today's schedule:\n${output}` }],
    };
  }
);

/**
 * Agenda for N days
 */
export const calendarAgendaTool = tool(
  "calendar_agenda",
  "List calendar events for today, tomorrow, or a specific date range.",
  {
    days: z.number().min(1).max(14).default(2).describe("How many days ahead (default: 2, max: 14)"),
    start: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to today if omitted."),
  },
  async ({ days, start }) => {
    // Compute end date = start + days
    const startDate = start ? new Date(start) : new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + days);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const args = ["agenda", "--tsv", fmt(startDate), fmt(endDate)];

    const { output, error } = await gcalcli(args);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Calendar error: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: `No events found for the next ${days} days.` }],
      };
    }

    // TSV: start_date, start_time, end_date, end_time, title
    const lines = output.split("\n").filter(l => l && !l.startsWith("start_date"));
    const formatted = lines.map((line) => {
      const cols = line.split("\t");
      const [date, time, , , title] = cols;
      return `• ${date}${time ? " " + time : ""} — ${title}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `📅 Calendar (${days} days):\n${formatted.join("\n")}`,
        },
      ],
    };
  }
);

/**
 * Search events
 */
export const calendarSearchTool = tool(
  "calendar_search",
  "Search calendar events.",
  {
    query: z.string().describe("Search term (event title, location, etc.)"),
    days: z.number().min(1).max(90).default(30).describe("Search within how many days (default: 30)"),
  },
  async ({ query, days }) => {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + days);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const { output, error } = await gcalcli(["search", query, fmt(today), fmt(end)]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Search error: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${query}".` }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `🔍 Search results for "${query}":\n${output}` }],
    };
  }
);

/**
 * Add event
 */
export const calendarAddTool = tool(
  "calendar_add",
  "Add a new event to Google Calendar.",
  {
    title: z.string().describe("Event title"),
    when: z.string().describe("Date and time. E.g. '2026-02-21 14:00' or 'tomorrow 15:00'"),
    duration: z.string().optional().describe("Duration. E.g. '1h', '30m', '2h30m'. Default: 1 hour."),
    description: z.string().optional().describe("Event description"),
    calendar: z.string().optional().describe("Calendar to add to (default: primary)"),
  },
  async ({ title, when, duration, description, calendar }) => {
    // gcalcli add --noprompt --title "..." --when "..." --duration 60 --description "..."
    const args = ["add", "--noprompt", "--title", title, "--when", when];

    if (duration) {
      // Convert duration string to minutes for gcalcli
      const mins = parseDurationToMinutes(duration);
      if (mins) args.push("--duration", String(mins));
    }

    if (description) args.push("--description", description);
    if (calendar) args.push("--calendar", calendar);

    const { output, error } = await gcalcli(args);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Failed to add event: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Event added: "${title}" — ${when}${duration ? ` (${duration})` : ""}${output ? `\n${output}` : ""}`,
        },
      ],
    };
  }
);

/**
 * Parse duration string to minutes
 * Supports: "1h", "30m", "1h30m", "90" (minutes)
 */
function parseDurationToMinutes(duration: string): number | null {
  const hourMatch = duration.match(/(\d+)h/);
  const minMatch = duration.match(/(\d+)m/);

  if (!hourMatch && !minMatch) {
    // Try as plain number (minutes)
    const num = parseInt(duration);
    return isNaN(num) ? null : num;
  }

  const hours = hourMatch ? parseInt(hourMatch[1]!) : 0;
  const mins = minMatch ? parseInt(minMatch[1]!) : 0;
  return hours * 60 + mins;
}

// ========== SERVER ==========

let calendarServer: ReturnType<typeof createSdkMcpServer> | null = null;

/**
 * Create Google Calendar MCP server (shared, not user-specific)
 * OAuth token stored in ~/.config/gcalcli/
 */
export function createCalendarServer() {
  return createSdkMcpServer({
    name: "cobrain-calendar",
    version: "1.0.0",
    tools: [calendarTodayTool, calendarAgendaTool, calendarSearchTool, calendarAddTool],
  });
}

/**
 * Get or create the shared calendar server
 */
export function getCalendarServer() {
  if (!calendarServer) {
    calendarServer = createCalendarServer();
  }
  return calendarServer;
}

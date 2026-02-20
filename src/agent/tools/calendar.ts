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
    const message = error instanceof Error ? error.message : "gcalcli hatası";
    return { output: "", error: message };
  }
}

/**
 * Today's events
 */
export const calendarTodayTool = tool(
  "calendar_today",
  "Bugünkü takvim etkinliklerini gösterir.",
  {},
  async () => {
    const { output, error } = await gcalcli(["agenda", "--nostarted", "--details", "length"]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Takvim hatası: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: "Bugün için takvimde etkinlik yok." }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `📅 Bugünkü program:\n${output}` }],
    };
  }
);

/**
 * Agenda for N days
 */
export const calendarAgendaTool = tool(
  "calendar_agenda",
  "Takvim etkinliklerini listeler. Bugün, yarın veya belirli bir gün aralığı için.",
  {
    days: z.number().min(1).max(14).default(2).describe("Kaç gün ileriye bak (varsayılan: 2, max: 14)"),
    start: z.string().optional().describe("Başlangıç tarihi (YYYY-MM-DD). Boş bırakılırsa bugün."),
  },
  async ({ days, start }) => {
    const args = ["agenda", "--tsv", "--details", "length", "--days", String(days)];
    if (start) args.push(start);

    const { output, error } = await gcalcli(args);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Takvim hatası: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: `Önümüzdeki ${days} gün için etkinlik bulunamadı.` }],
      };
    }

    // TSV formatını okunabilir hale getir
    const lines = output.split("\n").filter(Boolean);
    const formatted = lines.map((line) => {
      const cols = line.split("\t");
      // TSV: date, time, duration, title, location, description
      const [date, time, , title] = cols;
      return `• ${date} ${time} — ${title}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `📅 Takvim (${days} gün):\n${formatted.join("\n")}`,
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
  "Takvimde etkinlik ara.",
  {
    query: z.string().describe("Arama terimi (etkinlik adı, yer, vb.)"),
    days: z.number().min(1).max(90).default(30).describe("Kaç gün içinde ara (varsayılan: 30)"),
  },
  async ({ query, days }) => {
    const { output, error } = await gcalcli(["search", query, "--days", String(days)]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Arama hatası: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: `"${query}" için sonuç bulunamadı.` }],
      };
    }

    return {
      content: [{ type: "text" as const, text: `🔍 "${query}" arama sonuçları:\n${output}` }],
    };
  }
);

/**
 * Add event
 */
export const calendarAddTool = tool(
  "calendar_add",
  "Google Calendar'a yeni etkinlik ekle.",
  {
    title: z.string().describe("Etkinlik başlığı"),
    when: z.string().describe("Tarih ve saat. Örn: '2026-02-21 14:00' veya 'yarın 15:00'"),
    duration: z.string().optional().describe("Süre. Örn: '1h', '30m', '2h30m'. Varsayılan: 1 saat."),
    description: z.string().optional().describe("Etkinlik açıklaması"),
    calendar: z.string().optional().describe("Hangi takvime eklensin (varsayılan: primary)"),
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
        content: [{ type: "text" as const, text: `Etkinlik eklenemedi: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Etkinlik eklendi: "${title}" — ${when}${duration ? ` (${duration})` : ""}${output ? `\n${output}` : ""}`,
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

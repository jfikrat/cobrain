/**
 * Mneme Tools — Memory file manipulation tools for consolidation agent.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { FileMemory } from "../memory/file-memory.ts";
import { toolError, toolSuccess } from "../utils/tool-response.ts";
import type { Bot } from "grammy";

export function createMnemeTools(deps: {
  memory: FileMemory;
  bot: Bot;
  userId: number;
}) {
  const { memory, bot, userId } = deps;

  const readMemoryTool = tool(
    "read_memory_files",
    "Read the facts.md and events.md files.",
    {
      days: z.number().default(90).describe("How many days of event history"),
    },
    async ({ days }) => {
      try {
        const all = await memory.readAll(days);
        if (!all) return toolSuccess("Memory files are empty.");
        return toolSuccess(all);
      } catch (error) {
        return toolError("Read error", error);
      }
    }
  );

  const archiveEventsTool = tool(
    "archive_events",
    "Archive specific date sections from events.md. Mneme decides WHICH dates to archive based on content evaluation. Archived events move to archive/YYYY-MM-events.md.",
    {
      dates: z.array(z.string()).describe("Date strings to archive (YYYY-MM-DD format)"),
      reason: z.string().describe("Brief reason for archiving these dates"),
    },
    async ({ dates, reason }) => {
      try {
        const count = await memory.archiveByDates(dates);
        if (count === 0) return toolSuccess("No matching date sections found.");
        console.log(`[Mneme] Archived ${count} date sections: ${reason}`);
        return toolSuccess(`${count} event sections archived. Reason: ${reason}`);
      } catch (error) {
        return toolError("Archive error", error);
      }
    }
  );

  const consolidateEventTool = tool(
    "consolidate_event",
    "Replace a verbose event section with a concise summary. Use this to compress long entries while preserving key information.",
    {
      date: z.string().describe("Date of the event section (YYYY-MM-DD)"),
      summary: z.string().describe("Concise replacement summary (keep essential facts, dates, names)"),
    },
    async ({ date, summary }) => {
      try {
        await memory.consolidateEvent(date, summary);
        console.log(`[Mneme] Consolidated event: ${date}`);
        return toolSuccess(`Event ${date} consolidated.`);
      } catch (error) {
        return toolError("Consolidate error", error);
      }
    }
  );

  const updateFactsTool = tool(
    "update_facts",
    "Update a section in facts.md or add a new one.",
    {
      section: z.string().describe("Section heading (e.g. 'Location', 'Career', 'Family')"),
      content: z.string().describe("Section content"),
    },
    async ({ section, content }) => {
      try {
        await memory.storeFact(section, content);
        console.log(`[Mneme] Updated facts [${section}]`);
        return toolSuccess(`facts.md updated: [${section}]`);
      } catch (error) {
        return toolError("Update error", error);
      }
    }
  );

  const logEventTool = tool(
    "log_event",
    "Add a new event to events.md.",
    {
      description: z.string().describe("Event description"),
      date: z.string().optional().describe("Date (YYYY-MM-DD, default: today)"),
    },
    async ({ description, date }) => {
      try {
        await memory.logEvent(description, date);
        return toolSuccess(`Event saved: ${description}`);
      } catch (error) {
        return toolError("Event save error", error);
      }
    }
  );

  const sendReportTool = tool(
    "send_report",
    "Send the consolidation summary report via Telegram.",
    {
      text: z.string().describe("Report text"),
    },
    async ({ text }) => {
      try {
        await bot.api.sendMessage(userId, `🧠 <b>Memory Consolidation</b>\n\n${text}`, {
          parse_mode: "HTML",
        });
        return toolSuccess("Report sent.");
      } catch (error) {
        return toolError("Report send error", error);
      }
    }
  );

  return createSdkMcpServer({
    name: "cobrain-mneme",
    version: "1.0.0",
    tools: [readMemoryTool, archiveEventsTool, consolidateEventTool, updateFactsTool, logEventTool, sendReportTool],
  });
}

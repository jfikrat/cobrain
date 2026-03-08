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
    "archive_old_events",
    "Move events older than the given number of days into the archive/ folder.",
    {
      days_old: z.number().default(90).describe("Archive events older than how many days"),
    },
    async ({ days_old }) => {
      try {
        const count = await memory.archiveOldEvents(days_old);
        if (count === 0) return toolSuccess("No old events to archive.");
        console.log(`[Mneme] Archived ${count} date sections (>${days_old} days old)`);
        return toolSuccess(`${count} event sections archived.`);
      } catch (error) {
        return toolError("Archive error", error);
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
    tools: [readMemoryTool, archiveEventsTool, updateFactsTool, logEventTool, sendReportTool],
  });
}

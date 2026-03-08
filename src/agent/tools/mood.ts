/**
 * Mood Tools for Cobrain Agent
 * MCP tools for mood tracking and analysis
 * Cobrain v0.7 - Proactive Level 3
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  getMoodTrackingService,
  type MoodType,
} from "../../services/mood-tracking.ts";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";

export const trackMoodTool = (userId: number) =>
  tool(
    "track_mood",
    "Record the user's mood. Use when the user states it explicitly or asks to log it manually.",
    {
      mood: z
        .enum(["great", "good", "neutral", "low", "bad"])
        .describe("Mood: great, good, neutral, low, bad"),
      energy: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe("Energy level (1-5)"),
      context: z
        .string()
        .optional()
        .describe("Context or note (optional)"),
      triggers: z
        .array(z.string())
        .default([])
        .describe("Triggers/reasons (optional)"),
    },
    async ({ mood, energy, context, triggers }) => {
      try {
        const service = await getMoodTrackingService(userId);
        const id = service.recordMood({
          mood,
          energy,
          context,
          triggers,
          source: "explicit",
          confidence: 1.0,
        });

        const moodLabels: Record<MoodType, string> = {
          great: "great",
          good: "good",
          neutral: "neutral",
          low: "low",
          bad: "bad",
        };

        console.log(`[Mood] User ${userId} explicitly recorded: ${mood}`);
        return toolSuccess(`Mood saved: ${moodLabels[mood]} (energy: ${energy}/5)`);
      } catch (error) {
        return toolError("Mood save error", error);
      }
    }
  );

export const getMoodTrendTool = (userId: number) =>
  tool(
    "get_mood_trend",
    "Analyze mood trend over the last X days.",
    {
      days: z
        .number()
        .min(1)
        .max(30)
        .default(7)
        .describe("Number of days to analyze"),
    },
    async ({ days }) => {
      try {
        const service = await getMoodTrackingService(userId);
        const trend = service.getMoodTrend(days);

        const directionLabels: Record<string, string> = {
          improving: "improving 📈",
          stable: "stable ➡️",
          declining: "declining 📉",
        };

        const moodLabels: Record<number, string> = {
          5: "great",
          4: "good",
          3: "neutral",
          2: "low",
          1: "bad",
        };

        const avgMoodLabel = moodLabels[Math.round(trend.averageMood)] || "unknown";

        return toolSuccess(`Mood Trend (last ${days} days):
- Direction: ${directionLabels[trend.direction]}
- Average mood: ${avgMoodLabel} (${trend.averageMood.toFixed(1)}/5)
- Average energy: ${trend.averageEnergy.toFixed(1)}/5
- Data points: ${trend.dataPoints}
- Period: ${trend.startDate.split("T")[0]} - ${trend.endDate.split("T")[0]}`);
      } catch (error) {
        return toolError("Trend analysis error", error);
      }
    }
  );

export const getMoodHistoryTool = (userId: number) =>
  tool(
    "get_mood_history",
    "Get mood history for the last X days.",
    {
      days: z
        .number()
        .min(1)
        .max(30)
        .default(7)
        .describe("Number of days to fetch"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of entries"),
    },
    async ({ days, limit }) => {
      try {
        const service = await getMoodTrackingService(userId);
        const history = service.getMoodHistory(days);

        if (history.length === 0) {
          return toolSuccess("No mood entries for this period.");
        }

        const moodEmojis: Record<MoodType, string> = {
          great: "🌟",
          good: "😊",
          neutral: "😐",
          low: "😔",
          bad: "😢",
        };

        const formatted = history
          .slice(0, limit)
          .map((entry, i) => {
            const date = new Date(entry.createdAt).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            const emoji = moodEmojis[entry.mood];
            const context = entry.context ? ` - ${entry.context}` : "";
            const source = entry.source === "inferred" ? " (inferred)" : "";
            return `${i + 1}. ${emoji} ${entry.mood} (energy: ${entry.energy}/5) - ${date}${context}${source}`;
          })
          .join("\n");

        return toolSuccess(`Mood History (last ${days} days):\n${formatted}`);
      } catch (error) {
        return toolError("History fetch error", error);
      }
    }
  );

export const getMoodStatsTool = (userId: number) =>
  tool(
    "get_mood_stats",
    "Show mood statistics.",
    {},
    async () => {
      try {
        const service = await getMoodTrackingService(userId);
        const stats = service.getStats();
        const byTimeOfDay = service.getMoodByTimeOfDay();

        const moodLabels: Record<MoodType, string> = {
          great: "Great",
          good: "Good",
          neutral: "Neutral",
          low: "Low",
          bad: "Bad",
        };

        const breakdown = Object.entries(stats.byMood)
          .map(([mood, count]) => `  ${moodLabels[mood as MoodType]}: ${count}`)
          .join("\n");

        const timeLabels: Record<string, string> = {
          morning: "Morning",
          afternoon: "Afternoon",
          evening: "Evening",
          night: "Night",
        };

        const timeBreakdown = Object.entries(byTimeOfDay)
          .map(([time, avg]) => `  ${timeLabels[time]}: ${avg.toFixed(1)}/5`)
          .join("\n");

        return toolSuccess(`Mood Statistics:

Total entries: ${stats.total}
Average energy: ${stats.averageEnergy.toFixed(1)}/5
Last entry: ${stats.lastEntry ? new Date(stats.lastEntry).toLocaleDateString("en-US") : "None"}

Mood Breakdown:
${breakdown}

Average by Time of Day (last 30 days):
${timeBreakdown}`);
      } catch (error) {
        return toolError("Stats error", error);
      }
    }
  );

export function createMoodServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-mood",
    version: "1.0.0",
    tools: [
      trackMoodTool(userId),
      getMoodTrendTool(userId),
      getMoodHistoryTool(userId),
      getMoodStatsTool(userId),
    ],
  });
}

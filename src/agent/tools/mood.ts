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
    "Kullanıcının ruh halini kaydet. Kullanıcı açıkça belirttiğinde veya manuel kayıt istediğinde kullan.",
    {
      mood: z
        .enum(["great", "good", "neutral", "low", "bad"])
        .describe("Ruh hali: great (harika), good (iyi), neutral (normal), low (düşük), bad (kötü)"),
      energy: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe("Enerji seviyesi (1-5)"),
      context: z
        .string()
        .optional()
        .describe("Bağlam veya not (opsiyonel)"),
      triggers: z
        .array(z.string())
        .default([])
        .describe("Tetikleyiciler/nedenler (opsiyonel)"),
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
          great: "harika",
          good: "iyi",
          neutral: "normal",
          low: "düşük",
          bad: "kötü",
        };

        console.log(`[Mood] User ${userId} explicitly recorded: ${mood}`);
        return toolSuccess(`Ruh hali kaydedildi: ${moodLabels[mood]} (enerji: ${energy}/5)`);
      } catch (error) {
        return toolError("Mood kayıt hatası", error);
      }
    }
  );

export const getMoodTrendTool = (userId: number) =>
  tool(
    "get_mood_trend",
    "Son X günün ruh hali trendini analiz et.",
    {
      days: z
        .number()
        .min(1)
        .max(30)
        .default(7)
        .describe("Analiz edilecek gün sayısı"),
    },
    async ({ days }) => {
      try {
        const service = await getMoodTrackingService(userId);
        const trend = service.getMoodTrend(days);

        const directionLabels: Record<string, string> = {
          improving: "iyileşiyor 📈",
          stable: "stabil ➡️",
          declining: "düşüyor 📉",
        };

        const moodLabels: Record<number, string> = {
          5: "harika",
          4: "iyi",
          3: "normal",
          2: "düşük",
          1: "kötü",
        };

        const avgMoodLabel = moodLabels[Math.round(trend.averageMood)] || "bilinmiyor";

        return toolSuccess(`Ruh Hali Trendi (son ${days} gün):
- Yön: ${directionLabels[trend.direction]}
- Ortalama mood: ${avgMoodLabel} (${trend.averageMood.toFixed(1)}/5)
- Ortalama enerji: ${trend.averageEnergy.toFixed(1)}/5
- Veri noktası: ${trend.dataPoints}
- Dönem: ${trend.startDate.split("T")[0]} - ${trend.endDate.split("T")[0]}`);
      } catch (error) {
        return toolError("Trend analiz hatası", error);
      }
    }
  );

export const getMoodHistoryTool = (userId: number) =>
  tool(
    "get_mood_history",
    "Son X günün ruh hali geçmişini getir.",
    {
      days: z
        .number()
        .min(1)
        .max(30)
        .default(7)
        .describe("Getirilecek gün sayısı"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maksimum kayıt sayısı"),
    },
    async ({ days, limit }) => {
      try {
        const service = await getMoodTrackingService(userId);
        const history = service.getMoodHistory(days);

        if (history.length === 0) {
          return toolSuccess("Bu dönemde kayıtlı ruh hali yok.");
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
            const date = new Date(entry.createdAt).toLocaleDateString("tr-TR", {
              weekday: "short",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            const emoji = moodEmojis[entry.mood];
            const context = entry.context ? ` - ${entry.context}` : "";
            const source = entry.source === "inferred" ? " (çıkarım)" : "";
            return `${i + 1}. ${emoji} ${entry.mood} (enerji: ${entry.energy}/5) - ${date}${context}${source}`;
          })
          .join("\n");

        return toolSuccess(`Ruh Hali Geçmişi (son ${days} gün):\n${formatted}`);
      } catch (error) {
        return toolError("Geçmiş getirme hatası", error);
      }
    }
  );

export const getMoodStatsTool = (userId: number) =>
  tool(
    "get_mood_stats",
    "Ruh hali istatistiklerini göster.",
    {},
    async () => {
      try {
        const service = await getMoodTrackingService(userId);
        const stats = service.getStats();
        const byTimeOfDay = service.getMoodByTimeOfDay();

        const moodLabels: Record<MoodType, string> = {
          great: "Harika",
          good: "İyi",
          neutral: "Normal",
          low: "Düşük",
          bad: "Kötü",
        };

        const breakdown = Object.entries(stats.byMood)
          .map(([mood, count]) => `  ${moodLabels[mood as MoodType]}: ${count}`)
          .join("\n");

        const timeLabels: Record<string, string> = {
          morning: "Sabah",
          afternoon: "Öğle",
          evening: "Akşam",
          night: "Gece",
        };

        const timeBreakdown = Object.entries(byTimeOfDay)
          .map(([time, avg]) => `  ${timeLabels[time]}: ${avg.toFixed(1)}/5`)
          .join("\n");

        return toolSuccess(`Ruh Hali İstatistikleri:

Toplam kayıt: ${stats.total}
Ortalama enerji: ${stats.averageEnergy.toFixed(1)}/5
Son kayıt: ${stats.lastEntry ? new Date(stats.lastEntry).toLocaleDateString("tr-TR") : "Yok"}

Mood Dağılımı:
${breakdown}

Zamana Göre Ortalama (son 30 gün):
${timeBreakdown}`);
      } catch (error) {
        return toolError("İstatistik hatası", error);
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

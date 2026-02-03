/**
 * Goals & Reminders Tools for Cobrain Agent
 * MCP tools for goal tracking and reminder management
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GoalsService, parseTimeString } from "../../services/goals.ts";
import { userManager } from "../../services/user-manager.ts";
import { createUserCache } from "../../utils/user-cache.ts";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";

// User-based GoalsService cache
const goalsCache = createUserCache(async (userId: number) => {
  const userDb = await userManager.getUserDb(userId);
  return new GoalsService(userDb);
});

// ========== GOAL TOOLS ==========

export const createGoalTool = (userId: number) =>
  tool(
    "create_goal",
    "Yeni bir hedef oluştur. Kullanıcının ulaşmak istediği amaçlar için kullan.",
    {
      title: z.string().describe("Hedef başlığı"),
      description: z.string().optional().describe("Hedef açıklaması (opsiyonel)"),
      priority: z.number().min(0).max(10).default(5).describe("Öncelik (0-10, yüksek = önemli)"),
      dueDate: z.string().optional().describe("Bitiş tarihi (YYYY-MM-DD formatında, opsiyonel)"),
    },
    async ({ title, description, priority, dueDate }) => {
      try {
        const goals = await goalsCache.get(userId);
        const goal = goals.createGoal({ title, description, priority, dueDate });

        console.log(`[Goals] Created goal #${goal.id} for user ${userId}: ${title}`);

        return toolSuccess(
          `✅ Hedef oluşturuldu:\n- ID: ${goal.id}\n- Başlık: ${goal.title}${goal.dueDate ? `\n- Bitiş: ${goal.dueDate}` : ""}`
        );
      } catch (error) {
        return toolError("Hedef oluşturulamadı", error);
      }
    }
  );

export const listGoalsTool = (userId: number) =>
  tool(
    "list_goals",
    "Aktif hedefleri listele.",
    {
      includeCompleted: z.boolean().default(false).describe("Tamamlananları da dahil et"),
    },
    async ({ includeCompleted }) => {
      try {
        const goals = await goalsCache.get(userId);
        const goalList = includeCompleted ? goals.getAllGoals() : goals.getActiveGoals();

        if (goalList.length === 0) {
          return toolSuccess(includeCompleted ? "Hiç hedef yok." : "Aktif hedef yok.");
        }

        const formatted = goalList
          .map((g) => {
            const status = g.status === "completed" ? "✅" : g.status === "abandoned" ? "❌" : "🎯";
            const progress = g.progress > 0 ? ` (${Math.round(g.progress * 100)}%)` : "";
            const due = g.dueDate ? ` [${g.dueDate}]` : "";
            return `${status} #${g.id}: ${g.title}${progress}${due}`;
          })
          .join("\n");

        return toolSuccess(`Hedefler:\n${formatted}`);
      } catch (error) {
        return toolError("Hedefler listelenemedi", error);
      }
    }
  );

export const completeGoalTool = (userId: number) =>
  tool(
    "complete_goal",
    "Hedefi tamamlandı olarak işaretle.",
    {
      goalId: z.number().describe("Hedef ID'si"),
    },
    async ({ goalId }) => {
      try {
        const goals = await goalsCache.get(userId);
        const goal = goals.completeGoal(goalId);

        if (!goal) {
          return toolError(`Hedef #${goalId} bulunamadı`, new Error("Not found"));
        }

        console.log(`[Goals] Completed goal #${goalId} for user ${userId}`);
        return toolSuccess(`✅ Hedef tamamlandı: "${goal.title}"`);
      } catch (error) {
        return toolError("Hedef tamamlanamadı", error);
      }
    }
  );

export const deleteGoalTool = (userId: number) =>
  tool(
    "delete_goal",
    "Hedefi sil.",
    {
      goalId: z.number().describe("Hedef ID'si"),
    },
    async ({ goalId }) => {
      try {
        const goals = await goalsCache.get(userId);
        const deleted = goals.deleteGoal(goalId);

        if (!deleted) {
          return toolError(`Hedef #${goalId} bulunamadı`, new Error("Not found"));
        }

        console.log(`[Goals] Deleted goal #${goalId} for user ${userId}`);
        return toolSuccess(`🗑️ Hedef #${goalId} silindi.`);
      } catch (error) {
        return toolError("Hedef silinemedi", error);
      }
    }
  );

// ========== REMINDER TOOLS ==========

export const createReminderTool = (userId: number) =>
  tool(
    "create_reminder",
    "Hatırlatıcı oluştur. Zaman formatları: '10m' (10 dakika), '1h' (1 saat), '2d' (2 gün), '15:30' (bugün saat), 'tomorrow 9:00'",
    {
      title: z.string().describe("Hatırlatıcı başlığı"),
      time: z.string().describe("Ne zaman hatırlat (örn: '10m', '1h', '2d', '15:30', 'tomorrow 9:00')"),
      message: z.string().optional().describe("Ek mesaj (opsiyonel)"),
      repeat: z.enum(["daily", "weekly", "monthly"]).optional().describe("Tekrar paterni (opsiyonel)"),
    },
    async ({ title, time, message, repeat }) => {
      try {
        const triggerAt = parseTimeString(time);
        if (!triggerAt) {
          return toolError(
            "Geçersiz zaman formatı",
            new Error(`"${time}" - Örnekler: 10m, 1h, 2d, 15:30, tomorrow 9:00`)
          );
        }

        const goals = await goalsCache.get(userId);
        const reminder = goals.createReminder({
          title,
          message,
          triggerAt: triggerAt.toISOString(),
          repeatPattern: repeat,
        });

        console.log(`[Reminders] Created reminder #${reminder.id} for user ${userId}: ${title}`);

        const timeStr = triggerAt.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });

        return toolSuccess(
          `⏰ Hatırlatıcı kuruldu:\n- ID: ${reminder.id}\n- "${title}"\n- Zaman: ${timeStr}${repeat ? `\n- Tekrar: ${repeat}` : ""}`
        );
      } catch (error) {
        return toolError("Hatırlatıcı oluşturulamadı", error);
      }
    }
  );

export const listRemindersTool = (userId: number) =>
  tool("list_reminders", "Bekleyen hatırlatıcıları listele.", {}, async () => {
    try {
      const goals = await goalsCache.get(userId);
      const reminders = goals.getPendingReminders();

      if (reminders.length === 0) {
        return toolSuccess("Bekleyen hatırlatıcı yok.");
      }

      const formatted = reminders
        .map((r) => {
          const time = new Date(r.triggerAt).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
          const repeat = r.repeatPattern ? ` 🔄${r.repeatPattern}` : "";
          return `⏰ #${r.id}: ${r.title} - ${time}${repeat}`;
        })
        .join("\n");

      return toolSuccess(`Bekleyen hatırlatıcılar:\n${formatted}`);
    } catch (error) {
      return toolError("Hatırlatıcılar listelenemedi", error);
    }
  });

export const cancelReminderTool = (userId: number) =>
  tool(
    "cancel_reminder",
    "Hatırlatıcıyı iptal et.",
    {
      reminderId: z.number().describe("Hatırlatıcı ID'si"),
    },
    async ({ reminderId }) => {
      try {
        const goals = await goalsCache.get(userId);
        const cancelled = goals.cancelReminder(reminderId);

        if (!cancelled) {
          return toolError(`Hatırlatıcı #${reminderId} bulunamadı`, new Error("Not found"));
        }

        console.log(`[Reminders] Cancelled reminder #${reminderId} for user ${userId}`);
        return toolSuccess(`🚫 Hatırlatıcı #${reminderId} iptal edildi.`);
      } catch (error) {
        return toolError("Hatırlatıcı iptal edilemedi", error);
      }
    }
  );

export const goalsStatsTool = (userId: number) =>
  tool("goals_stats", "Hedef ve hatırlatıcı istatistiklerini göster.", {}, async () => {
    try {
      const goals = await goalsCache.get(userId);
      const stats = goals.getStats();

      return toolSuccess(`📊 İstatistikler:
- Aktif hedefler: ${stats.activeGoals}
- Tamamlanan hedefler: ${stats.completedGoals}
- Bekleyen hatırlatıcılar: ${stats.pendingReminders}`);
    } catch (error) {
      return toolError("İstatistik hatası", error);
    }
  });

/**
 * Create Goals MCP server for a specific user
 */
export function createGoalsServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-goals",
    version: "1.0.0",
    tools: [
      createGoalTool(userId),
      listGoalsTool(userId),
      completeGoalTool(userId),
      deleteGoalTool(userId),
      createReminderTool(userId),
      listRemindersTool(userId),
      cancelReminderTool(userId),
      goalsStatsTool(userId),
    ],
  });
}

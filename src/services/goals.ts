/**
 * Goals and Reminders Service
 * Cobrain v0.2
 */

import { Database } from "bun:sqlite";
import type {
  Goal,
  GoalInput,
  GoalStatus,
  Reminder,
  ReminderInput,
  ReminderStatus,
} from "../types/autonomous.ts";

export class GoalsService {
  private db: Database;

  constructor(userDb: Database) {
    this.db = userDb;
    this.initTables();
  }

  private initTables(): void {
    // Goals table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        priority INTEGER DEFAULT 0,
        due_date DATE,
        progress REAL DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME
      )
    `);

    // Reminders table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT,
        trigger_at DATETIME NOT NULL,
        repeat_pattern TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)`);
  }

  // ========== GOAL METHODS ==========

  createGoal(input: GoalInput): Goal {
    const result = this.db.run(
      `INSERT INTO goals (title, description, priority, due_date, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.title,
        input.description ?? null,
        input.priority ?? 0,
        input.dueDate ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    return this.getGoal(Number(result.lastInsertRowid))!;
  }

  getGoal(goalId: number): Goal | null {
    const row = this.db
      .query<
        {
          id: number;
          title: string;
          description: string | null;
          status: string;
          priority: number;
          due_date: string | null;
          progress: number;
          metadata: string;
          created_at: string;
          updated_at: string | null;
        },
        [number]
      >("SELECT * FROM goals WHERE id = ?")
      .get(goalId);

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as GoalStatus,
      priority: row.priority,
      dueDate: row.due_date ?? undefined,
      progress: row.progress,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    };
  }

  getActiveGoals(): Goal[] {
    const rows = this.db
      .query<
        {
          id: number;
          title: string;
          description: string | null;
          status: string;
          priority: number;
          due_date: string | null;
          progress: number;
          metadata: string;
          created_at: string;
          updated_at: string | null;
        },
        []
      >("SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at DESC")
      .all();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as GoalStatus,
      priority: row.priority,
      dueDate: row.due_date ?? undefined,
      progress: row.progress,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    }));
  }

  getAllGoals(): Goal[] {
    const rows = this.db
      .query<
        {
          id: number;
          title: string;
          description: string | null;
          status: string;
          priority: number;
          due_date: string | null;
          progress: number;
          metadata: string;
          created_at: string;
          updated_at: string | null;
        },
        []
      >("SELECT * FROM goals ORDER BY status, priority DESC, created_at DESC")
      .all();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as GoalStatus,
      priority: row.priority,
      dueDate: row.due_date ?? undefined,
      progress: row.progress,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    }));
  }

  updateGoal(
    goalId: number,
    updates: Partial<Omit<Goal, "id" | "createdAt">>
  ): Goal | null {
    const current = this.getGoal(goalId);
    if (!current) return null;

    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      values.push(updates.description ?? null);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }
    if (updates.priority !== undefined) {
      fields.push("priority = ?");
      values.push(updates.priority);
    }
    if (updates.dueDate !== undefined) {
      fields.push("due_date = ?");
      values.push(updates.dueDate ?? null);
    }
    if (updates.progress !== undefined) {
      fields.push("progress = ?");
      values.push(updates.progress);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }

    if (fields.length === 0) return current;

    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(goalId);

    this.db.run(`UPDATE goals SET ${fields.join(", ")} WHERE id = ?`, values);

    return this.getGoal(goalId);
  }

  completeGoal(goalId: number): Goal | null {
    return this.updateGoal(goalId, { status: "completed", progress: 1.0 });
  }

  abandonGoal(goalId: number): Goal | null {
    return this.updateGoal(goalId, { status: "abandoned" });
  }

  deleteGoal(goalId: number): boolean {
    const result = this.db.run("DELETE FROM goals WHERE id = ?", [goalId]);
    return result.changes > 0;
  }

  // ========== REMINDER METHODS ==========

  createReminder(input: ReminderInput): Reminder {
    const result = this.db.run(
      `INSERT INTO reminders (title, message, trigger_at, repeat_pattern)
       VALUES (?, ?, ?, ?)`,
      [input.title, input.message ?? null, input.triggerAt, input.repeatPattern ?? null]
    );

    return this.getReminder(Number(result.lastInsertRowid))!;
  }

  getReminder(reminderId: number): Reminder | null {
    const row = this.db
      .query<
        {
          id: number;
          title: string;
          message: string | null;
          trigger_at: string;
          repeat_pattern: string | null;
          status: string;
          created_at: string;
        },
        [number]
      >("SELECT * FROM reminders WHERE id = ?")
      .get(reminderId);

    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      message: row.message ?? undefined,
      triggerAt: row.trigger_at,
      repeatPattern: row.repeat_pattern ?? undefined,
      status: row.status as ReminderStatus,
      createdAt: row.created_at,
    };
  }

  getPendingReminders(): Reminder[] {
    const rows = this.db
      .query<
        {
          id: number;
          title: string;
          message: string | null;
          trigger_at: string;
          repeat_pattern: string | null;
          status: string;
          created_at: string;
        },
        []
      >("SELECT * FROM reminders WHERE status = 'pending' ORDER BY trigger_at ASC")
      .all();

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      message: row.message ?? undefined,
      triggerAt: row.trigger_at,
      repeatPattern: row.repeat_pattern ?? undefined,
      status: row.status as ReminderStatus,
      createdAt: row.created_at,
    }));
  }

  getDueReminders(): Reminder[] {
    const now = new Date().toISOString();

    const rows = this.db
      .query<
        {
          id: number;
          title: string;
          message: string | null;
          trigger_at: string;
          repeat_pattern: string | null;
          status: string;
          created_at: string;
        },
        [string]
      >("SELECT * FROM reminders WHERE status = 'pending' AND trigger_at <= ? ORDER BY trigger_at ASC")
      .all(now);

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      message: row.message ?? undefined,
      triggerAt: row.trigger_at,
      repeatPattern: row.repeat_pattern ?? undefined,
      status: row.status as ReminderStatus,
      createdAt: row.created_at,
    }));
  }

  markReminderSent(reminderId: number): void {
    const reminder = this.getReminder(reminderId);
    if (!reminder) return;

    if (reminder.repeatPattern) {
      // Recurring reminder - calculate next trigger
      const nextTrigger = this.calculateNextTrigger(reminder.triggerAt, reminder.repeatPattern);
      this.db.run("UPDATE reminders SET trigger_at = ? WHERE id = ?", [nextTrigger, reminderId]);
    } else {
      // One-time reminder - mark as sent
      this.db.run("UPDATE reminders SET status = 'sent' WHERE id = ?", [reminderId]);
    }
  }

  snoozeReminder(reminderId: number, minutes: number): Reminder | null {
    const reminder = this.getReminder(reminderId);
    if (!reminder) return null;

    const newTrigger = new Date();
    newTrigger.setMinutes(newTrigger.getMinutes() + minutes);

    this.db.run("UPDATE reminders SET trigger_at = ?, status = 'pending' WHERE id = ?", [
      newTrigger.toISOString(),
      reminderId,
    ]);

    return this.getReminder(reminderId);
  }

  cancelReminder(reminderId: number): boolean {
    const result = this.db.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", [reminderId]);
    return result.changes > 0;
  }

  deleteReminder(reminderId: number): boolean {
    const result = this.db.run("DELETE FROM reminders WHERE id = ?", [reminderId]);
    return result.changes > 0;
  }

  /**
   * Calculate next trigger time for recurring reminders
   */
  private calculateNextTrigger(currentTrigger: string, pattern: string): string {
    const current = new Date(currentTrigger);
    const next = new Date(current);

    // Simple patterns: daily, weekly, monthly
    switch (pattern.toLowerCase()) {
      case "daily":
        next.setDate(next.getDate() + 1);
        break;
      case "weekly":
        next.setDate(next.getDate() + 7);
        break;
      case "monthly":
        next.setMonth(next.getMonth() + 1);
        break;
      default:
        // Assume it's a number of hours
        const hours = parseInt(pattern, 10);
        if (!isNaN(hours)) {
          next.setHours(next.getHours() + hours);
        } else {
          next.setDate(next.getDate() + 1); // Default to daily
        }
    }

    return next.toISOString();
  }

  // ========== STATS ==========

  getStats(): { activeGoals: number; completedGoals: number; pendingReminders: number } {
    const activeGoals =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM goals WHERE status = 'active'")
        .get()?.count ?? 0;

    const completedGoals =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM goals WHERE status = 'completed'")
        .get()?.count ?? 0;

    const pendingReminders =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM reminders WHERE status = 'pending'")
        .get()?.count ?? 0;

    return { activeGoals, completedGoals, pendingReminders };
  }
}

// Factory function to get GoalsService for a user
const goalsServices = new Map<number, GoalsService>();

export async function getGoalsService(userDb: Database, userId: number): Promise<GoalsService> {
  let service = goalsServices.get(userId);
  if (!service) {
    service = new GoalsService(userDb);
    goalsServices.set(userId, service);
  }
  return service;
}

/**
 * Parse time string to Date
 * Supports: "10m", "1h", "2d", "tomorrow 9:00", "15:30"
 */
export function parseTimeString(timeStr: string): Date | null {
  const now = new Date();

  // Relative time: 10m, 1h, 2d
  const relativeMatch = timeStr.match(/^(\d+)([mhd])$/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]!, 10);
    const unit = relativeMatch[2]!.toLowerCase();

    const result = new Date(now);
    switch (unit) {
      case "m":
        result.setMinutes(result.getMinutes() + amount);
        break;
      case "h":
        result.setHours(result.getHours() + amount);
        break;
      case "d":
        result.setDate(result.getDate() + amount);
        break;
    }
    return result;
  }

  // Tomorrow with time: "tomorrow 9:00"
  const tomorrowMatch = timeStr.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/i);
  if (tomorrowMatch) {
    const result = new Date(now);
    result.setDate(result.getDate() + 1);
    result.setHours(parseInt(tomorrowMatch[1]!, 10), parseInt(tomorrowMatch[2]!, 10), 0, 0);
    return result;
  }

  // Time only: "15:30" (today or tomorrow if past)
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const result = new Date(now);
    result.setHours(parseInt(timeMatch[1]!, 10), parseInt(timeMatch[2]!, 10), 0, 0);

    // If time has passed today, set to tomorrow
    if (result <= now) {
      result.setDate(result.getDate() + 1);
    }
    return result;
  }

  // Date and time: "2026-01-27 15:30"
  const dateTimeMatch = timeStr.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (dateTimeMatch) {
    const [_, dateStr, hour, minute] = dateTimeMatch;
    const result = new Date(dateStr!);
    result.setHours(parseInt(hour!, 10), parseInt(minute!, 10), 0, 0);
    return result;
  }

  return null;
}

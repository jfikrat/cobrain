/**
 * Reminders Service
 * Extracted from goals.ts — only reminder functionality
 */

import { Database } from "bun:sqlite";

export type ReminderStatus = "pending" | "sent" | "cancelled";

export interface Reminder {
  id: number;
  title: string;
  message?: string;
  triggerAt: string;
  repeatPattern?: string;
  status: ReminderStatus;
  context: Record<string, unknown>;
  maxExecutions?: number;
  executionsDone: number;
  createdAt: string;
}

export interface ReminderInput {
  title: string;
  message?: string;
  triggerAt: string;
  repeatPattern?: string;
  context?: Record<string, unknown>;
  maxExecutions?: number;
}

export class RemindersService {
  private db: Database;

  constructor(userDb: Database) {
    this.db = userDb;
    this.initTable();
  }

  private initTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT,
        trigger_at DATETIME NOT NULL,
        repeat_pattern TEXT,
        status TEXT DEFAULT 'pending',
        context TEXT DEFAULT '{}',
        max_executions INTEGER,
        executions_done INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { this.db.run(`ALTER TABLE reminders ADD COLUMN context TEXT DEFAULT '{}'`); } catch {}
    try { this.db.run(`ALTER TABLE reminders ADD COLUMN max_executions INTEGER`); } catch {}
    try { this.db.run(`ALTER TABLE reminders ADD COLUMN executions_done INTEGER DEFAULT 0`); } catch {}

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)`);
  }

  private mapRow(row: {
    id: number;
    title: string;
    message: string | null;
    trigger_at: string;
    repeat_pattern: string | null;
    status: string;
    context: string | null;
    max_executions: number | null;
    executions_done: number;
    created_at: string;
  }): Reminder {
    return {
      id: row.id,
      title: row.title,
      message: row.message ?? undefined,
      triggerAt: row.trigger_at,
      repeatPattern: row.repeat_pattern ?? undefined,
      status: row.status as ReminderStatus,
      context: JSON.parse(row.context || "{}"),
      maxExecutions: row.max_executions ?? undefined,
      executionsDone: row.executions_done ?? 0,
      createdAt: row.created_at,
    };
  }

  private queryRows(sql: string, params: unknown[] = []): Reminder[] {
    const rows = this.db.query<{
      id: number; title: string; message: string | null;
      trigger_at: string; repeat_pattern: string | null; status: string;
      context: string | null; max_executions: number | null;
      executions_done: number; created_at: string;
    }, unknown[]>(sql).all(...params);
    return rows.map((r) => this.mapRow(r));
  }

  createReminder(input: ReminderInput): Reminder {
    const result = this.db.run(
      `INSERT INTO reminders (title, message, trigger_at, repeat_pattern, context, max_executions)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.title, input.message ?? null, input.triggerAt, input.repeatPattern ?? null,
       JSON.stringify(input.context ?? {}), input.maxExecutions ?? null]
    );
    return this.getReminder(Number(result.lastInsertRowid))!;
  }

  getReminder(id: number): Reminder | null {
    const rows = this.queryRows("SELECT * FROM reminders WHERE id = ?", [id]);
    return rows[0] ?? null;
  }

  getPendingReminders(): Reminder[] {
    return this.queryRows("SELECT * FROM reminders WHERE status = 'pending' ORDER BY trigger_at ASC");
  }

  getDueReminders(): Reminder[] {
    return this.queryRows(
      "SELECT * FROM reminders WHERE status = 'pending' AND trigger_at <= ? ORDER BY trigger_at ASC",
      [new Date().toISOString()]
    );
  }

  markReminderSent(reminderId: number): void {
    const reminder = this.getReminder(reminderId);
    if (!reminder) return;

    const newExec = (reminder.executionsDone ?? 0) + 1;

    if (reminder.repeatPattern) {
      if (reminder.maxExecutions && newExec >= reminder.maxExecutions) {
        this.db.run("UPDATE reminders SET status = 'sent', executions_done = ? WHERE id = ?", [newExec, reminderId]);
        console.log(`[Reminders] #${reminderId} completed after ${newExec}/${reminder.maxExecutions} executions`);
        return;
      }
      const nextTrigger = this.calculateNextTrigger(reminder.triggerAt, reminder.repeatPattern);
      this.db.run("UPDATE reminders SET trigger_at = ?, executions_done = ? WHERE id = ?", [nextTrigger, newExec, reminderId]);
      console.log(`[Reminders] #${reminderId} execution ${newExec}${reminder.maxExecutions ? `/${reminder.maxExecutions}` : ""}, next: ${nextTrigger}`);
    } else {
      this.db.run("UPDATE reminders SET status = 'sent', executions_done = ? WHERE id = ?", [newExec, reminderId]);
    }
  }

  snoozeReminder(reminderId: number, minutes: number): Reminder | null {
    const reminder = this.getReminder(reminderId);
    if (!reminder) return null;
    const newTrigger = new Date();
    newTrigger.setMinutes(newTrigger.getMinutes() + minutes);
    this.db.run("UPDATE reminders SET trigger_at = ?, status = 'pending' WHERE id = ?", [newTrigger.toISOString(), reminderId]);
    return this.getReminder(reminderId);
  }

  deleteReminder(reminderId: number): boolean {
    return this.db.run("DELETE FROM reminders WHERE id = ?", [reminderId]).changes > 0;
  }

  getPendingCount(): number {
    return this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM reminders WHERE status = 'pending'").get()?.count ?? 0;
  }

  private calculateNextTrigger(currentTrigger: string, pattern: string): string {
    const now = new Date();
    const current = new Date(currentTrigger);
    const base = current < now ? now : current;
    const next = new Date(base);

    switch (pattern.toLowerCase()) {
      case "daily": next.setDate(next.getDate() + 1); return next.toISOString();
      case "weekly": next.setDate(next.getDate() + 7); return next.toISOString();
      case "monthly": next.setMonth(next.getMonth() + 1); return next.toISOString();
    }

    const m = pattern.match(/^(\d+)([mhd])$/i);
    if (m) {
      const amount = parseInt(m[1]!, 10);
      switch (m[2]!.toLowerCase()) {
        case "m": next.setMinutes(next.getMinutes() + amount); break;
        case "h": next.setHours(next.getHours() + amount); break;
        case "d": next.setDate(next.getDate() + amount); break;
      }
      return next.toISOString();
    }

    const hours = parseInt(pattern, 10);
    if (!isNaN(hours)) { next.setHours(next.getHours() + hours); return next.toISOString(); }

    next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
}

// Factory
const services = new Map<number, RemindersService>();

export async function getRemindersService(userDb: Database, userId: number): Promise<RemindersService> {
  let s = services.get(userId);
  if (!s) { s = new RemindersService(userDb); services.set(userId, s); }
  return s;
}

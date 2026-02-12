/**
 * Scheduler Service - Cron-based task scheduling
 * Cobrain v0.2
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../config.ts";
import { heartbeat } from "./heartbeat.ts";
import type { ScheduledTask, TaskType } from "../types/autonomous.ts";

export interface SchedulerConfig {
  checkIntervalMs: number; // How often to check for due tasks
  enabled: boolean;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  checkIntervalMs: 60_000, // 1 minute
  enabled: true,
};

export class Scheduler {
  private globalDb: Database;
  private config: SchedulerConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private taskHandlers: Map<TaskType, (task: ScheduledTask) => Promise<void>> = new Map();
  private running: boolean = false;

  constructor(globalDbPath?: string, schedulerConfig?: Partial<SchedulerConfig>) {
    const dbPath = globalDbPath || join(config.COBRAIN_BASE_PATH, "cobrain.db");
    this.globalDb = new Database(dbPath, { create: true });
    this.config = { ...DEFAULT_CONFIG, ...schedulerConfig };

    this.initTables();
  }

  private initTables(): void {
    // Ensure scheduled_tasks table exists
    this.globalDb.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        config TEXT DEFAULT '{}',
        enabled INTEGER DEFAULT 1,
        last_run_at DATETIME,
        next_run_at DATETIME,
        running_since DATETIME DEFAULT NULL
      )
    `);

    // Migration: add running_since column for existing installs
    try {
      this.globalDb.run(`ALTER TABLE scheduled_tasks ADD COLUMN running_since DATETIME DEFAULT NULL`);
      console.log("[Scheduler] Migrated: added running_since column");
    } catch {
      // Column already exists — ignore
    }

    this.globalDb.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_next_run ON scheduled_tasks(next_run_at)`);
    this.globalDb.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_enabled ON scheduled_tasks(enabled)`);
  }

  /**
   * Register a handler for a specific task type
   */
  registerHandler(taskType: TaskType, handler: (task: ScheduledTask) => Promise<void>): void {
    this.taskHandlers.set(taskType, handler);
    console.log(`[Scheduler] Handler registered: ${taskType}`);
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (!this.config.enabled) {
      console.log("[Scheduler] Disabled by config");
      return;
    }

    if (this.running) {
      console.log("[Scheduler] Already running");
      return;
    }

    // Crash recovery: clear stale running_since locks from previous process
    const recovered = this.globalDb.run(
      `UPDATE scheduled_tasks SET running_since = NULL WHERE running_since IS NOT NULL`
    );
    if (recovered.changes > 0) {
      console.log(`[Scheduler] Recovered ${recovered.changes} stuck task(s) from previous run`);
    }

    this.running = true;
    console.log(`[Scheduler] Started (check interval: ${this.config.checkIntervalMs}ms)`);

    // Heartbeat: scheduler started
    heartbeat("scheduler", { event: "started" });

    // Initial check
    this.checkAndRunTasks();

    // Set up periodic checks
    this.intervalId = setInterval(() => {
      heartbeat("scheduler", { event: "tick" });
      this.checkAndRunTasks();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log("[Scheduler] Stopped");
  }

  /**
   * Check for due tasks and run them
   */
  private async checkAndRunTasks(): Promise<void> {
    const now = new Date().toISOString();

    // Get due tasks (skip already-running ones via running_since lock)
    const dueTasks = this.globalDb
      .query<
        {
          id: number;
          user_id: number;
          task_type: string;
          schedule: string;
          config: string;
          enabled: number;
          last_run_at: string | null;
          next_run_at: string | null;
        },
        [string]
      >(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1
         AND running_since IS NULL
         AND (next_run_at IS NULL OR next_run_at <= ?)
         ORDER BY next_run_at ASC`
      )
      .all(now);

    for (const row of dueTasks) {
      const task: ScheduledTask = {
        id: row.id,
        userId: row.user_id,
        taskType: row.task_type as TaskType,
        schedule: row.schedule,
        config: JSON.parse(row.config || "{}"),
        enabled: row.enabled === 1,
        lastRunAt: row.last_run_at ?? undefined,
        nextRunAt: row.next_run_at ?? undefined,
      };

      await this.runTask(task);
    }
  }

  /**
   * Run a single task
   */
  private async runTask(task: ScheduledTask): Promise<void> {
    const handler = this.taskHandlers.get(task.taskType);

    if (!handler) {
      console.warn(`[Scheduler] No handler for task type: ${task.taskType}`);
      return;
    }

    // Atomic claim: set running_since lock (prevents overlap)
    const claimed = this.globalDb.run(
      `UPDATE scheduled_tasks SET running_since = CURRENT_TIMESTAMP
       WHERE id = ? AND running_since IS NULL`,
      [task.id]
    );
    if (claimed.changes === 0) {
      console.log(`[Scheduler] Task #${task.id} already running, skipping`);
      return;
    }

    try {
      console.log(`[Scheduler] Running task #${task.id} (${task.taskType}) for user ${task.userId}`);

      await handler(task);

      // Update last_run_at, calculate next_run_at, release lock
      const nextRun = this.calculateNextRun(task.schedule);

      this.globalDb.run(
        `UPDATE scheduled_tasks
         SET last_run_at = CURRENT_TIMESTAMP, next_run_at = ?, running_since = NULL
         WHERE id = ?`,
        [nextRun, task.id]
      );

      console.log(`[Scheduler] Task #${task.id} completed, next run: ${nextRun}`);
    } catch (error) {
      console.error(`[Scheduler] Task #${task.id} failed:`, error);

      // Still update next_run_at and release lock to prevent infinite retries
      const nextRun = this.calculateNextRun(task.schedule);
      this.globalDb.run(
        `UPDATE scheduled_tasks SET next_run_at = ?, running_since = NULL WHERE id = ?`,
        [nextRun, task.id]
      );
    }
  }

  /**
   * Calculate next run time from cron schedule
   * Simple implementation - supports: minute hour day month weekday
   */
  calculateNextRun(schedule: string): string {
    const parts = schedule.split(" ");
    if (parts.length !== 5) {
      // Invalid cron, default to 1 hour later
      const next = new Date();
      next.setHours(next.getHours() + 1);
      return next.toISOString();
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const now = new Date();
    const next = new Date(now);

    // Simple logic: if specific hour/minute, set to next occurrence
    if (hour !== "*" && minute !== "*") {
      const targetHour = parseInt(hour!, 10);
      const targetMinute = parseInt(minute!, 10);

      next.setHours(targetHour, targetMinute, 0, 0);

      // If already passed today, move to tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      // Handle day of week
      if (dayOfWeek && dayOfWeek !== "*") {
        const targetDay = parseInt(dayOfWeek, 10);
        while (next.getDay() !== targetDay) {
          next.setDate(next.getDate() + 1);
        }
      }
    } else {
      // Default: 1 hour later
      next.setHours(next.getHours() + 1);
    }

    return next.toISOString();
  }

  /**
   * Schedule a new task
   */
  scheduleTask(
    userId: number,
    taskType: TaskType,
    schedule: string,
    taskConfig?: Record<string, unknown>
  ): number {
    const nextRun = this.calculateNextRun(schedule);

    const result = this.globalDb.run(
      `INSERT INTO scheduled_tasks (user_id, task_type, schedule, config, next_run_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, taskType, schedule, JSON.stringify(taskConfig || {}), nextRun]
    );

    console.log(`[Scheduler] Task scheduled: ${taskType} for user ${userId}, next run: ${nextRun}`);
    return Number(result.lastInsertRowid);
  }

  /**
   * Get scheduled tasks for a user
   */
  getUserTasks(userId: number): ScheduledTask[] {
    const rows = this.globalDb
      .query<
        {
          id: number;
          user_id: number;
          task_type: string;
          schedule: string;
          config: string;
          enabled: number;
          last_run_at: string | null;
          next_run_at: string | null;
        },
        [number]
      >("SELECT * FROM scheduled_tasks WHERE user_id = ?")
      .all(userId);

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      taskType: row.task_type as TaskType,
      schedule: row.schedule,
      config: JSON.parse(row.config || "{}"),
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined,
    }));
  }

  /**
   * Enable/disable a task
   */
  setTaskEnabled(taskId: number, enabled: boolean): void {
    this.globalDb.run("UPDATE scheduled_tasks SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, taskId]);
  }

  /**
   * Delete a scheduled task
   */
  deleteTask(taskId: number): void {
    this.globalDb.run("DELETE FROM scheduled_tasks WHERE id = ?", [taskId]);
  }

  /**
   * Setup default tasks for a new user
   */
  setupDefaultTasks(userId: number): void {
    // Check if user already has tasks
    const existing = this.globalDb
      .query<{ count: number }, [number]>("SELECT COUNT(*) as count FROM scheduled_tasks WHERE user_id = ?")
      .get(userId);

    if (existing && existing.count > 0) {
      return; // Already has tasks
    }

    // Daily summary at 9:00 AM
    this.scheduleTask(userId, "daily_summary", "0 9 * * *", { enabled: true });

    // Weekly goal check on Sundays at 10:00 AM
    this.scheduleTask(userId, "goal_check", "0 10 * * 0", { enabled: true });

    // Memory prune weekly on Mondays at 3:00 AM
    this.scheduleTask(userId, "memory_prune", "0 3 * * 1", { enabled: true });

    // Memory consolidation weekly on Sundays at 4:00 AM
    this.scheduleTask(userId, "memory_consolidation", "0 4 * * 0", { enabled: true });

    console.log(`[Scheduler] Default tasks created for user ${userId}`);
  }

  /**
   * Ensure a specific task type exists for a user (backfill for new task types)
   */
  ensureTask(userId: number, taskType: TaskType, schedule: string, taskConfig?: Record<string, unknown>): void {
    const existing = this.globalDb
      .query<{ count: number }, [number, string]>(
        "SELECT COUNT(*) as count FROM scheduled_tasks WHERE user_id = ? AND task_type = ?"
      )
      .get(userId, taskType);

    if (existing && existing.count > 0) return;

    this.scheduleTask(userId, taskType, schedule, taskConfig);
    console.log(`[Scheduler] Backfilled task ${taskType} for user ${userId}`);
  }

  close(): void {
    this.stop();
    this.globalDb.close();
  }
}

// Singleton will be created in index.ts
let schedulerInstance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    schedulerInstance = new Scheduler();
  }
  return schedulerInstance;
}

export function initScheduler(config?: Partial<SchedulerConfig>): Scheduler {
  if (schedulerInstance) {
    schedulerInstance.close();
  }
  schedulerInstance = new Scheduler(undefined, config);
  return schedulerInstance;
}

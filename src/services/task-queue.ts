/**
 * Task Queue Service - Background task processing
 * Cobrain v0.2
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../config.ts";
import { heartbeat } from "./heartbeat.ts";
import type { QueuedTask, TaskType, TaskResult, TaskStatus } from "../types/autonomous.ts";

export interface TaskQueueConfig {
  processIntervalMs: number;
  maxConcurrent: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: TaskQueueConfig = {
  processIntervalMs: 5_000, // 5 seconds
  maxConcurrent: 3,
  enabled: true,
};

export class TaskQueue {
  private globalDb: Database;
  private config: TaskQueueConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private taskHandlers: Map<TaskType, (task: QueuedTask) => Promise<TaskResult>> = new Map();
  private runningTasks: Set<number> = new Set();
  private running: boolean = false;

  constructor(globalDbPath?: string, queueConfig?: Partial<TaskQueueConfig>) {
    const dbPath = globalDbPath || join(config.COBRAIN_BASE_PATH, "cobrain.db");
    this.globalDb = new Database(dbPath, { create: true });
    this.config = { ...DEFAULT_CONFIG, ...queueConfig };

    this.initTables();
  }

  private initTables(): void {
    this.globalDb.run(`
      CREATE TABLE IF NOT EXISTS task_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        error TEXT,
        source_key TEXT DEFAULT NULL
      )
    `);

    // Migration: add source_key column for existing installs
    try {
      this.globalDb.run(`ALTER TABLE task_queue ADD COLUMN source_key TEXT DEFAULT NULL`);
      console.log("[TaskQueue] Migrated: added source_key column");
    } catch {
      // Column already exists — ignore
    }

    this.globalDb.run(`CREATE INDEX IF NOT EXISTS idx_queue_status ON task_queue(status, priority DESC)`);
    this.globalDb.run(`CREATE INDEX IF NOT EXISTS idx_queue_user ON task_queue(user_id)`);
    this.globalDb.run(`CREATE INDEX IF NOT EXISTS idx_queue_source_key ON task_queue(source_key, status)`);
  }

  /**
   * Register a handler for a task type
   */
  registerHandler(taskType: TaskType, handler: (task: QueuedTask) => Promise<TaskResult>): void {
    this.taskHandlers.set(taskType, handler);
    console.log(`[TaskQueue] Handler registered: ${taskType}`);
  }

  /**
   * Start processing the queue
   */
  start(): void {
    if (!this.config.enabled) {
      console.log("[TaskQueue] Disabled by config");
      return;
    }

    if (this.running) {
      console.log("[TaskQueue] Already running");
      return;
    }

    // Crash recovery: reset stuck 'running' tasks from previous process
    const recovered = this.globalDb.run(
      `UPDATE task_queue SET status = 'pending', started_at = NULL WHERE status = 'running'`
    );
    if (recovered.changes > 0) {
      console.log(`[TaskQueue] Recovered ${recovered.changes} stuck task(s) from previous run`);
    }

    this.running = true;
    console.log(`[TaskQueue] Started (interval: ${this.config.processIntervalMs}ms)`);

    // Heartbeat: task queue started
    heartbeat("task_queue", { event: "started" });

    // Initial process
    this.processQueue();

    // Set up periodic processing
    this.intervalId = setInterval(() => {
      heartbeat("task_queue", { event: "tick" });
      this.processQueue();
    }, this.config.processIntervalMs);
  }

  /**
   * Stop processing
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log("[TaskQueue] Stopped");
  }

  /**
   * Process pending tasks
   */
  private async processQueue(): Promise<void> {
    // Check how many tasks we can run
    const available = this.config.maxConcurrent - this.runningTasks.size;
    if (available <= 0) return;

    // Atomic claim: SELECT + UPDATE in a single transaction
    const claimTasks = this.globalDb.transaction((limit: number) => {
      const pending = this.globalDb
        .query<
          {
            id: number;
            user_id: number;
            task_type: string;
            payload: string;
            priority: number;
            status: string;
            created_at: string;
            started_at: string | null;
            completed_at: string | null;
            error: string | null;
            source_key: string | null;
          },
          [number]
        >(
          `SELECT * FROM task_queue
           WHERE status = 'pending'
           ORDER BY priority DESC, created_at ASC
           LIMIT ?`
        )
        .all(limit);

      const claimed: typeof pending = [];
      for (const row of pending) {
        if (this.runningTasks.has(row.id)) continue;
        this.globalDb.run(
          `UPDATE task_queue SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`,
          [row.id]
        );
        claimed.push(row);
      }
      return claimed;
    });

    const claimedTasks = claimTasks(available);

    for (const row of claimedTasks) {
      const task: QueuedTask = {
        id: row.id,
        userId: row.user_id,
        taskType: row.task_type as TaskType,
        payload: JSON.parse(row.payload),
        priority: row.priority,
        status: "running" as TaskStatus,
        createdAt: row.created_at,
        startedAt: new Date().toISOString(),
        completedAt: row.completed_at ?? undefined,
        error: row.error ?? undefined,
        sourceKey: row.source_key ?? undefined,
      };

      // Run task in background
      this.runTask(task);
    }
  }

  /**
   * Run a single task
   */
  private async runTask(task: QueuedTask): Promise<void> {
    const handler = this.taskHandlers.get(task.taskType);

    if (!handler) {
      console.warn(`[TaskQueue] No handler for task type: ${task.taskType}`);
      this.updateTaskStatus(task.id, "failed", "No handler registered");
      return;
    }

    this.runningTasks.add(task.id);

    // Already marked as 'running' in processQueue transaction

    try {
      console.log(`[TaskQueue] Processing task #${task.id} (${task.taskType})`);

      const result = await handler(task);

      if (result.success) {
        this.updateTaskStatus(task.id, "completed");
        console.log(`[TaskQueue] Task #${task.id} completed`);
      } else {
        this.updateTaskStatus(task.id, "failed", result.error || "Unknown error");
        console.warn(`[TaskQueue] Task #${task.id} failed: ${result.error}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.updateTaskStatus(task.id, "failed", errorMsg);
      console.error(`[TaskQueue] Task #${task.id} error:`, error);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Update task status
   */
  private updateTaskStatus(taskId: number, status: TaskStatus, error?: string): void {
    if (status === "completed" || status === "failed") {
      this.globalDb.run(
        `UPDATE task_queue SET status = ?, completed_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?`,
        [status, error ?? null, taskId]
      );
    } else {
      this.globalDb.run(`UPDATE task_queue SET status = ? WHERE id = ?`, [status, taskId]);
    }
  }

  /**
   * Add a task to the queue
   */
  enqueue(
    userId: number,
    taskType: TaskType,
    payload: Record<string, unknown>,
    priority: number = 0,
    sourceKey?: string
  ): number | null {
    // Dedup: if sourceKey given, check for existing pending/running task with same key
    if (sourceKey) {
      const existing = this.globalDb
        .query<{ id: number }, [string]>(
          `SELECT id FROM task_queue WHERE source_key = ? AND status IN ('pending', 'running') LIMIT 1`
        )
        .get(sourceKey);

      if (existing) {
        console.log(`[TaskQueue] Dedup: task with key "${sourceKey}" already queued (#${existing.id}), skipping`);
        return null;
      }
    }

    const result = this.globalDb.run(
      `INSERT INTO task_queue (user_id, task_type, payload, priority, source_key)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, taskType, JSON.stringify(payload), priority, sourceKey ?? null]
    );

    const taskId = Number(result.lastInsertRowid);
    console.log(`[TaskQueue] Task #${taskId} queued (${taskType}, priority: ${priority}${sourceKey ? `, key: ${sourceKey}` : ""})`);

    return taskId;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: number): QueuedTask | null {
    const row = this.globalDb
      .query<
        {
          id: number;
          user_id: number;
          task_type: string;
          payload: string;
          priority: number;
          status: string;
          created_at: string;
          started_at: string | null;
          completed_at: string | null;
          error: string | null;
        },
        [number]
      >("SELECT * FROM task_queue WHERE id = ?")
      .get(taskId);

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      taskType: row.task_type as TaskType,
      payload: JSON.parse(row.payload),
      priority: row.priority,
      status: row.status as TaskStatus,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    };
  }

  /**
   * Get user's queued tasks
   */
  getUserTasks(userId: number, includeCompleted: boolean = false): QueuedTask[] {
    const query = includeCompleted
      ? "SELECT * FROM task_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
      : "SELECT * FROM task_queue WHERE user_id = ? AND status IN ('pending', 'running') ORDER BY priority DESC, created_at ASC";

    const rows = this.globalDb
      .query<
        {
          id: number;
          user_id: number;
          task_type: string;
          payload: string;
          priority: number;
          status: string;
          created_at: string;
          started_at: string | null;
          completed_at: string | null;
          error: string | null;
        },
        [number]
      >(query)
      .all(userId);

    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      taskType: row.task_type as TaskType,
      payload: JSON.parse(row.payload),
      priority: row.priority,
      status: row.status as TaskStatus,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    }));
  }

  /**
   * Cancel a pending task
   */
  cancel(taskId: number): boolean {
    const result = this.globalDb.run(
      `UPDATE task_queue SET status = 'failed', error = 'Cancelled' WHERE id = ? AND status = 'pending'`,
      [taskId]
    );
    return result.changes > 0;
  }

  /**
   * Clean up old completed/failed tasks
   */
  cleanup(olderThanDays: number = 7): number {
    const result = this.globalDb.run(
      `DELETE FROM task_queue
       WHERE status IN ('completed', 'failed')
       AND completed_at < datetime('now', '-' || ? || ' days')`,
      [olderThanDays]
    );
    return result.changes;
  }

  /**
   * Get queue stats
   */
  getStats(): { pending: number; running: number; completed: number; failed: number } {
    const pending =
      this.globalDb
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM task_queue WHERE status = 'pending'")
        .get()?.count ?? 0;

    const running =
      this.globalDb
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM task_queue WHERE status = 'running'")
        .get()?.count ?? 0;

    const completed =
      this.globalDb
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM task_queue WHERE status = 'completed'")
        .get()?.count ?? 0;

    const failed =
      this.globalDb
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM task_queue WHERE status = 'failed'")
        .get()?.count ?? 0;

    return { pending, running, completed, failed };
  }

  close(): void {
    this.stop();
    this.globalDb.close();
  }
}

// Singleton
let queueInstance: TaskQueue | null = null;

export function getTaskQueue(): TaskQueue {
  if (!queueInstance) {
    queueInstance = new TaskQueue();
  }
  return queueInstance;
}

export function initTaskQueue(config?: Partial<TaskQueueConfig>): TaskQueue {
  if (queueInstance) {
    queueInstance.close();
  }
  queueInstance = new TaskQueue(undefined, config);
  return queueInstance;
}

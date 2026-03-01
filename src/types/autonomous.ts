/**
 * Autonomous operation type definitions for Cobrain
 * Scheduled tasks and queue types
 */

export type TaskType =
  | "daily_summary"
  | "goal_check"
  | "reminder"
  | "memory_prune"
  | "memory_consolidation"
  | "custom";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface ScheduledTask {
  id: number;
  userId: number;
  taskType: TaskType;
  schedule: string; // cron pattern
  config: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  runningSince?: string; // lock timestamp — NULL = idle, non-NULL = running
}

export interface QueuedTask {
  id: number;
  userId: number;
  taskType: TaskType;
  payload: Record<string, unknown>;
  priority: number; // 0 = lowest, higher = urgent
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  sourceKey?: string; // dedup key — e.g. "reminder:5", "scheduled:3"
}

export interface TaskResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

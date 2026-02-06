/**
 * Autonomous operation type definitions for Cobrain v0.2
 * Goals, reminders, scheduled tasks
 */

export type GoalStatus = "active" | "completed" | "abandoned" | "paused";

export interface Goal {
  id: number;
  title: string;
  description?: string;
  status: GoalStatus;
  priority: number; // 0-10, higher = more important
  dueDate?: string; // ISO date
  progress: number; // 0.0 - 1.0
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  lastFollowupAt?: string; // Last time a follow-up was sent
  followupIntervalDays?: number; // Days between follow-ups (default: 7)
}

export interface GoalInput {
  title: string;
  description?: string;
  priority?: number;
  dueDate?: string;
  metadata?: Record<string, unknown>;
}

export type ReminderStatus = "pending" | "sent" | "snoozed" | "cancelled";

export interface Reminder {
  id: number;
  title: string;
  message?: string;
  triggerAt: string; // ISO datetime
  repeatPattern?: string; // "daily", "weekly", "monthly", or interval like "2m", "5h"
  status: ReminderStatus;
  createdAt: string;
  context?: Record<string, unknown>; // Metadata: chatId, action type, etc.
  maxExecutions?: number; // Max times to fire (null = unlimited for repeating)
  executionsDone: number; // How many times fired so far
}

export interface ReminderInput {
  title: string;
  message?: string;
  triggerAt: string;
  repeatPattern?: string;
  context?: Record<string, unknown>;
  maxExecutions?: number;
}

export type TaskType =
  | "daily_summary"
  | "goal_check"
  | "reminder"
  | "memory_prune"
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
}

export interface TaskResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

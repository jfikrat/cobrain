/**
 * Brain Events — Type definitions for event sourcing, tracing, and routing
 * Phase 1: Event Brain + Router-lite
 */

// ─── Trace ───────────────────────────────────────────────

export interface TraceContext {
  traceId: string; // 12-char hex — unique per user request
  causationId?: string; // event ID that triggered this event
  channel: "telegram" | "whatsapp" | "api" | "system";
}

/** Generate a 12-character trace ID (no external deps) */
export function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// ─── Event Types ─────────────────────────────────────────

export type BrainEventType =
  | "message.user.received"
  | "message.assistant.sent"
  | "agent.run.started"
  | "agent.run.completed"
  | "agent.run.failed"
  | "agent.tool.called"
  | "route.decision"
  | "proactive.notification.sent"
  | "proactive.notification.skipped";

// ─── Event Record ────────────────────────────────────────

export interface BrainEvent {
  id?: number;
  ts?: string;
  userId: number;
  traceId: string;
  causationId?: string;
  eventType: BrainEventType;
  channel?: string;
  actor: "user" | "agent" | "scheduler" | "proactive" | "system";
  entityType?: string; // "session" | "memory" | "goal" | "reminder"
  entityId?: string;
  payload: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

// ─── Feature Flags ───────────────────────────────────────

export interface FeatureFlags {
  FF_BRAIN_EVENTS: boolean; // Event logging active
}

// ─── Route Decision ──────────────────────────────────────

export type RouteLevel = "fast" | "default" | "deep";

export interface RouteDecision {
  model: string;
  level: RouteLevel;
  reason: string;
}

// ─── Event Stats (for projections) ──────────────────────

export interface EventStats {
  totalEvents: number;
  totalCost: number;
  totalRequests: number;
  avgLatencyMs: number;
  modelBreakdown: Record<string, number>;
  errorRate: number;
}

export interface DailyProjection {
  date: string;
  totalCost: number;
  totalRequests: number;
  avgLatencyMs: number;
  modelBreakdown: { fast: number; default: number; deep: number };
  toolUsage: Record<string, number>;
  errorRate: number;
  routeDecisions: { fast: number; default: number; deep: number };
}

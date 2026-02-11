/**
 * Brain Projections — Batch computations over event log
 * Phase 1: Daily cost, model breakdown, agent quality metrics
 */

import type { DailyProjection } from "../types/brain-events.ts";
import { getEventStore } from "./event-store.ts";

/**
 * Compute daily projection from the last 24h of events.
 * Designed to run on a timer (every 5 min or as a daily batch).
 */
export function computeDailyProjection(): DailyProjection | null {
  const store = getEventStore();
  if (!store) return null;

  const stats = store.getStats(1);
  const toolUsage = store.getToolUsage(1);

  return {
    date: new Date().toISOString().slice(0, 10),
    totalCost: stats.totalCost,
    totalRequests: stats.totalRequests,
    avgLatencyMs: stats.avgLatencyMs,
    modelBreakdown: {
      fast: stats.modelBreakdown["fast"] ?? 0,
      default: stats.modelBreakdown["default"] ?? 0,
      deep: stats.modelBreakdown["deep"] ?? 0,
    },
    toolUsage,
    errorRate: stats.errorRate,
    routeDecisions: {
      fast: stats.modelBreakdown["fast"] ?? 0,
      default: stats.modelBreakdown["default"] ?? 0,
      deep: stats.modelBreakdown["deep"] ?? 0,
    },
  };
}

// Projection interval handle
let projectionInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic projection computation (every 5 minutes).
 * Results are logged; future phases can persist or expose via API.
 */
export function startProjectionScheduler(): void {
  // Run immediately once
  logProjection();

  // Then every 5 minutes
  projectionInterval = setInterval(logProjection, 5 * 60 * 1000);
  console.log("[Projections] Scheduler started (every 5 min)");
}

/** Stop the projection scheduler */
export function stopProjectionScheduler(): void {
  if (projectionInterval) {
    clearInterval(projectionInterval);
    projectionInterval = null;
    console.log("[Projections] Scheduler stopped");
  }
}

function logProjection(): void {
  const projection = computeDailyProjection();
  if (!projection) return;

  // Only log if there's activity
  if (projection.totalRequests === 0) return;

  console.log(
    `[Projections] Daily: ${projection.totalRequests} reqs, $${projection.totalCost.toFixed(4)} cost, ${projection.avgLatencyMs}ms avg | ` +
      `Route: fast=${projection.routeDecisions.fast} default=${projection.routeDecisions.default} deep=${projection.routeDecisions.deep} | ` +
      `Errors: ${(projection.errorRate * 100).toFixed(1)}%`
  );
}

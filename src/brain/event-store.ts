/**
 * Brain Event Store — Append-only event log on SQLite
 * Phase 1: Event Brain
 */

import { Database } from "bun:sqlite";
import type { BrainEvent, EventStats } from "../types/brain-events.ts";

export class EventStore {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.initTable();
    this.insertStmt = this.db.prepare(`
      INSERT INTO brain_events (
        user_id, trace_id, causation_id, event_type, channel,
        actor, entity_type, entity_id, payload_json,
        input_tokens, output_tokens, cost_usd, latency_ms
      ) VALUES (
        $userId, $traceId, $causationId, $eventType, $channel,
        $actor, $entityType, $entityId, $payloadJson,
        $inputTokens, $outputTokens, $costUsd, $latencyMs
      )
    `);
  }

  private initTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS brain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER NOT NULL,
        trace_id TEXT NOT NULL,
        causation_id TEXT,
        event_type TEXT NOT NULL,
        channel TEXT,
        actor TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        payload_json TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        latency_ms INTEGER
      )
    `);

    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_events_trace ON brain_events(trace_id)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_events_type_ts ON brain_events(event_type, ts DESC)`
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_events_user_ts ON brain_events(user_id, ts DESC)`
    );
  }

  /** Append a new event, return its ID */
  append(event: BrainEvent): number {
    const result = this.insertStmt.run({
      $userId: event.userId,
      $traceId: event.traceId,
      $causationId: event.causationId ?? null,
      $eventType: event.eventType,
      $channel: event.channel ?? null,
      $actor: event.actor,
      $entityType: event.entityType ?? null,
      $entityId: event.entityId ?? null,
      $payloadJson: JSON.stringify(event.payload),
      $inputTokens: event.inputTokens ?? 0,
      $outputTokens: event.outputTokens ?? 0,
      $costUsd: event.costUsd ?? 0,
      $latencyMs: event.latencyMs ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  /** Get all events for a trace */
  getByTrace(traceId: string): BrainEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM brain_events WHERE trace_id = ? ORDER BY id ASC`
      )
      .all(traceId) as RawEventRow[];

    return rows.map(toEvent);
  }

  /** Get most recent events */
  getRecent(limit: number = 50): BrainEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM brain_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as RawEventRow[];

    return rows.map(toEvent);
  }

  /** Aggregate stats for the last N days */
  getStats(days: number = 1): EventStats {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_events,
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COUNT(DISTINCT trace_id) as total_requests,
          COALESCE(AVG(CASE WHEN latency_ms > 0 THEN latency_ms END), 0) as avg_latency
        FROM brain_events
        WHERE ts >= datetime('now', '-' || ? || ' days')`
      )
      .get(days) as {
      total_events: number;
      total_cost: number;
      total_requests: number;
      avg_latency: number;
    };

    // Model breakdown from route.decision events
    const modelRows = this.db
      .prepare(
        `SELECT
          json_extract(payload_json, '$.level') as level,
          COUNT(*) as cnt
        FROM brain_events
        WHERE event_type = 'route.decision'
          AND ts >= datetime('now', '-' || ? || ' days')
        GROUP BY level`
      )
      .all(days) as { level: string; cnt: number }[];

    const modelBreakdown: Record<string, number> = {};
    for (const r of modelRows) {
      modelBreakdown[r.level] = r.cnt;
    }

    // Error rate
    const errorCount =
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as cnt FROM brain_events
          WHERE event_type = 'agent.run.failed'
            AND ts >= datetime('now', '-' || ? || ' days')`
          )
          .get(days) as { cnt: number }
      )?.cnt ?? 0;

    const totalRequests = row?.total_requests ?? 0;

    return {
      totalEvents: row?.total_events ?? 0,
      totalCost: row?.total_cost ?? 0,
      totalRequests,
      avgLatencyMs: Math.round(row?.avg_latency ?? 0),
      modelBreakdown,
      errorRate: totalRequests > 0 ? errorCount / totalRequests : 0,
    };
  }

  /** Tool usage breakdown for the last N days */
  getToolUsage(days: number = 1): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT
          json_extract(payload_json, '$.tool') as tool,
          COUNT(*) as cnt
        FROM brain_events
        WHERE event_type = 'agent.tool.called'
          AND ts >= datetime('now', '-' || ? || ' days')
        GROUP BY tool
        ORDER BY cnt DESC`
      )
      .all(days) as { tool: string; cnt: number }[];

    const usage: Record<string, number> = {};
    for (const r of rows) {
      if (r.tool) usage[r.tool] = r.cnt;
    }
    return usage;
  }
}

// ─── Raw row mapping ─────────────────────────────────────

interface RawEventRow {
  id: number;
  ts: string;
  user_id: number;
  trace_id: string;
  causation_id: string | null;
  event_type: string;
  channel: string | null;
  actor: string;
  entity_type: string | null;
  entity_id: string | null;
  payload_json: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
}

function toEvent(row: RawEventRow): BrainEvent {
  return {
    id: row.id,
    ts: row.ts,
    userId: row.user_id,
    traceId: row.trace_id,
    causationId: row.causation_id ?? undefined,
    eventType: row.event_type as BrainEvent["eventType"],
    channel: row.channel ?? undefined,
    actor: row.actor as BrainEvent["actor"],
    entityType: row.entity_type ?? undefined,
    entityId: row.entity_id ?? undefined,
    payload: JSON.parse(row.payload_json),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms ?? undefined,
  };
}

// ─── Singleton ───────────────────────────────────────────

let instance: EventStore | null = null;

/** Initialize the event store with the global database */
export function initEventStore(db: Database): EventStore {
  instance = new EventStore(db);
  console.log("[EventStore] Initialized");
  return instance;
}

/** Get the singleton event store (must be initialized first) */
export function getEventStore(): EventStore | null {
  return instance;
}

import { config } from "../config.ts";

type HeartbeatStatus = "healthy" | "degraded";

interface HeartbeatComponent {
  name: string;
  required: boolean;
  staleAfterMs: number;
  lastBeatAt: number | null;
  beatCount: number;
  lastDetails: Record<string, unknown> | null;
}

interface HeartbeatHealth {
  status: HeartbeatStatus;
  staleRequired: string[];
  staleOptional: string[];
  checkedAt: string;
}

const components = new Map<string, HeartbeatComponent>();

let monitorIntervalId: ReturnType<typeof setInterval> | null = null;

function now(): number {
  return Date.now();
}

function toIso(ts: number | null): string | null {
  return ts ? new Date(ts).toISOString() : null;
}

export function registerHeartbeatComponent(
  name: string,
  options?: {
    required?: boolean;
    staleAfterMs?: number;
  }
): void {
  if (!config.ENABLE_HEARTBEAT_MONITORING) return;

  const existing = components.get(name);
  if (existing) {
    existing.required = options?.required ?? existing.required;
    existing.staleAfterMs = options?.staleAfterMs ?? existing.staleAfterMs;
    return;
  }

  components.set(name, {
    name,
    required: options?.required ?? true,
    staleAfterMs: options?.staleAfterMs ?? config.HEARTBEAT_STALE_AFTER_MS,
    lastBeatAt: null,
    beatCount: 0,
    lastDetails: null,
  });
}

export function heartbeat(
  name: string,
  details?: Record<string, unknown>
): void {
  if (!config.ENABLE_HEARTBEAT_MONITORING) return;

  if (!components.has(name)) {
    registerHeartbeatComponent(name);
  }

  const component = components.get(name);
  if (!component) return;

  component.lastBeatAt = now();
  component.beatCount += 1;
  component.lastDetails = details ?? null;
}

export function getHeartbeatHealth(): HeartbeatHealth {
  const checkedAt = now();
  const staleRequired: string[] = [];
  const staleOptional: string[] = [];

  for (const component of components.values()) {
    if (!component.lastBeatAt) {
      if (component.required) staleRequired.push(component.name);
      else staleOptional.push(component.name);
      continue;
    }

    const age = checkedAt - component.lastBeatAt;
    if (age > component.staleAfterMs) {
      if (component.required) staleRequired.push(component.name);
      else staleOptional.push(component.name);
    }
  }

  return {
    status: staleRequired.length > 0 ? "degraded" : "healthy",
    staleRequired,
    staleOptional,
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

export function getHeartbeatSnapshot() {
  const checkedAt = now();
  const health = getHeartbeatHealth();

  return {
    enabled: config.ENABLE_HEARTBEAT_MONITORING,
    health,
    components: Array.from(components.values()).map((component) => {
      const ageMs = component.lastBeatAt ? checkedAt - component.lastBeatAt : null;

      return {
        name: component.name,
        required: component.required,
        staleAfterMs: component.staleAfterMs,
        lastBeatAt: toIso(component.lastBeatAt),
        ageMs,
        beatCount: component.beatCount,
        stale: ageMs === null ? true : ageMs > component.staleAfterMs,
        lastDetails: component.lastDetails,
      };
    }),
  };
}

export function startHeartbeatMonitor(): void {
  if (!config.ENABLE_HEARTBEAT_MONITORING) return;
  if (monitorIntervalId) return;

  monitorIntervalId = setInterval(() => {
    const health = getHeartbeatHealth();
    if (health.status === "degraded") {
      console.warn(
        `[Heartbeat] degraded | required stale: ${health.staleRequired.join(", ") || "-"} | optional stale: ${health.staleOptional.join(", ") || "-"}`
      );
    }
  }, config.HEARTBEAT_LOG_INTERVAL_MS);
}

export function stopHeartbeatMonitor(): void {
  if (!monitorIntervalId) return;
  clearInterval(monitorIntervalId);
  monitorIntervalId = null;
}

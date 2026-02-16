/**
 * Sentinel Types — Haiku Sentinel type definitions
 */

export interface SentinelConfig {
  model: string;
  notebookPath: string;
  maxTurns: number;
  consolidationThreshold: number;
  maxWakesPerHour: number;
  userId: number;
}

export interface SentinelEvent {
  type:
    | "whatsapp_dm"
    | "whatsapp_group"
    | "reminder_due"
    | "periodic_check"
    | "expectation_timeout";
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface SentinelResult {
  action: "replied" | "notified" | "woke_opus" | "noted" | "none";
  details?: string;
  tokensUsed?: number;
}

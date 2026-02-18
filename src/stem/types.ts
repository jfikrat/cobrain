/**
 * Stem Types — Haiku Stem type definitions
 */

export interface StemConfig {
  model: string;
  notebookPath: string;
  maxTurns: number;
  consolidationThreshold: number;
  maxWakesPerHour: number;
  userId: number;
}

export interface StemEvent {
  type:
    | "whatsapp_dm"
    | "whatsapp_group"
    | "reminder_due"
    | "periodic_check"
    | "expectation_timeout";
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface StemResult {
  action: "replied" | "notified" | "woke_opus" | "noted" | "none";
  details?: string;
  tokensUsed?: number;
}

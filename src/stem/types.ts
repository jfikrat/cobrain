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
  userFolder: string;
}

export interface StemEvent {
  type:
    | "whatsapp_dm"
    | "whatsapp_group"
    | "reminder_due"
    | "expectation_timeout";
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface StemResult {
  action: "replied" | "notified" | "woke_cortex" | "noted" | "none";
  details?: string;
  tokensUsed?: number;
}

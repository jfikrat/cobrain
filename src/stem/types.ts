/**
 * Stem Types — Triage classifier type definitions
 */

export interface StemConfig {
  model: string;
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

export type TriageAction = "reply" | "wake_cortex" | "notify" | "ignore";

export interface TriageDecision {
  action: TriageAction;
  reply?: string;       // action=reply ise gönderilecek mesaj
  reason: string;       // kısa açıklama (loglama için)
  urgency?: "immediate" | "soon";  // action=wake_cortex için
}

/**
 * User-related type definitions for Cobrain v0.2
 */

export interface User {
  id: number; // Telegram user ID
  createdAt: string;
  lastSeenAt: string;
  folderPath: string;
  settings: UserSettings;
}

export interface UserSettings {
  /** Permission mode for tool approvals (default: smart) */
  permissionMode?: "strict" | "smart" | "yolo";

  /** Timezone for scheduling (default: Europe/Istanbul) */
  timezone?: string;

  /** Language preference (default: tr) */
  language?: string;

  /** Enable daily summary (default: true) */
  dailySummary?: boolean;

  /** Daily summary time (cron format, default: 0 9 * * *) */
  dailySummaryTime?: string;

  /** Enable proactive goal reminders */
  goalReminders?: boolean;

  /** Max memory entries to keep */
  maxMemoryEntries?: number;

  /** Custom preferences (JSON) */
  custom?: Record<string, unknown>;

  // ===== Kullanıcı Profili =====
  /** Kullanıcının adı */
  profileName?: string;

  /** Kullanıcının mesleği/rolü */
  profileRole?: string;

  /** Kullanıcının ilgi alanları */
  profileInterests?: string[];

  /** Özel notlar/tercihler */
  profileNotes?: string;
}

export interface UserStats {
  messageCount: number;
  sessionCount: number;
  memoryCount: number;
  goalsActive: number;
  remindersPending: number;
  lastActivity: string | null;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  timezone: "Europe/Istanbul",
  language: "tr",
  dailySummary: true,
  dailySummaryTime: "0 9 * * *",
  goalReminders: true,
  maxMemoryEntries: 10000,
};

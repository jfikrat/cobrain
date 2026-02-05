/**
 * Activity Patterns Service - User interaction timing analysis
 * Cobrain v0.7 - Proactive Level 3
 */

import { Database } from "bun:sqlite";
import { userManager } from "./user-manager.ts";

export interface TimeSlot {
  hour: number;
  dayOfWeek: number;
  score: number; // 0.0-1.0, higher = more active
}

export interface QuietHours {
  start: number; // Hour (0-23)
  end: number; // Hour (0-23)
}

export class ActivityPatternService {
  private db: Database;
  private userId: number;

  constructor(userDb: Database, userId: number) {
    this.db = userDb;
    this.userId = userId;
    this.initTable();
  }

  private initTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_activity_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour INTEGER NOT NULL CHECK(hour BETWEEN 0 AND 23),
        day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
        interaction_count INTEGER DEFAULT 0,
        avg_response_time_ms INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(hour, day_of_week)
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_patterns_slot ON user_activity_patterns(hour, day_of_week)`);

    // Initialize all time slots if empty
    const count = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM user_activity_patterns")
      .get()?.count ?? 0;

    if (count === 0) {
      // Insert all 168 slots (24 hours x 7 days)
      for (let day = 0; day < 7; day++) {
        for (let hour = 0; hour < 24; hour++) {
          this.db.run(
            "INSERT INTO user_activity_patterns (hour, day_of_week, interaction_count) VALUES (?, ?, 0)",
            [hour, day]
          );
        }
      }
      console.log(`[ActivityPatterns] Initialized 168 time slots for user ${this.userId}`);
    }
  }

  /**
   * Record a user interaction
   */
  recordInteraction(timestamp: Date = new Date()): void {
    const hour = timestamp.getHours();
    const dayOfWeek = timestamp.getDay();

    this.db.run(
      `UPDATE user_activity_patterns
       SET interaction_count = interaction_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE hour = ? AND day_of_week = ?`,
      [hour, dayOfWeek]
    );
  }

  /**
   * Get optimal notification times (top N most active slots)
   */
  getOptimalNotificationTimes(limit: number = 5): TimeSlot[] {
    const rows = this.db
      .query<{
        hour: number;
        day_of_week: number;
        interaction_count: number;
      }, [number]>(
        `SELECT hour, day_of_week, interaction_count
         FROM user_activity_patterns
         WHERE hour BETWEEN 8 AND 22
         ORDER BY interaction_count DESC
         LIMIT ?`
      )
      .all(limit);

    // Normalize to 0-1 score
    const maxCount = rows[0]?.interaction_count ?? 1;

    return rows.map((row) => ({
      hour: row.hour,
      dayOfWeek: row.day_of_week,
      score: maxCount > 0 ? row.interaction_count / maxCount : 0,
    }));
  }

  /**
   * Check if current time is good for notifications
   */
  shouldNotifyNow(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    // Hard constraints: never notify at night
    if (hour < 8 || hour > 22) {
      return false;
    }

    // Get current slot's activity level
    const row = this.db
      .query<{ interaction_count: number }, [number, number]>(
        `SELECT interaction_count FROM user_activity_patterns WHERE hour = ? AND day_of_week = ?`
      )
      .get(hour, dayOfWeek);

    const count = row?.interaction_count ?? 0;

    // Get average interaction count for all active hours
    const avgRow = this.db
      .query<{ avg: number }, []>(
        `SELECT AVG(interaction_count) as avg FROM user_activity_patterns WHERE hour BETWEEN 8 AND 22`
      )
      .get();

    const avg = avgRow?.avg ?? 0;

    // Notify if current slot is at least 50% of average activity
    return count >= avg * 0.5;
  }

  /**
   * Get current slot's activity score (0-1)
   */
  getCurrentSlotScore(): number {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    const row = this.db
      .query<{ interaction_count: number }, [number, number]>(
        `SELECT interaction_count FROM user_activity_patterns WHERE hour = ? AND day_of_week = ?`
      )
      .get(hour, dayOfWeek);

    const count = row?.interaction_count ?? 0;

    // Get max count for normalization
    const maxRow = this.db
      .query<{ max: number }, []>(
        `SELECT MAX(interaction_count) as max FROM user_activity_patterns`
      )
      .get();

    const max = maxRow?.max ?? 1;

    return max > 0 ? count / max : 0;
  }

  /**
   * Get adaptive quiet hours based on user activity
   */
  getAdaptiveQuietHours(): QuietHours {
    // Find the least active continuous period at night
    const rows = this.db
      .query<{
        hour: number;
        total_count: number;
      }, []>(
        `SELECT hour, SUM(interaction_count) as total_count
         FROM user_activity_patterns
         GROUP BY hour
         ORDER BY hour`
      )
      .all();

    // Default quiet hours
    let quietStart = 22;
    let quietEnd = 8;

    // Find continuous low-activity period
    const threshold = rows.reduce((sum, r) => sum + r.total_count, 0) / rows.length * 0.1;

    let currentStart: number | null = null;
    let longestStart = 22;
    let longestDuration = 0;

    for (const row of rows) {
      if (row.total_count <= threshold) {
        if (currentStart === null) {
          currentStart = row.hour;
        }
      } else {
        if (currentStart !== null) {
          const duration = row.hour - currentStart;
          if (duration > longestDuration) {
            longestDuration = duration;
            longestStart = currentStart;
          }
        }
        currentStart = null;
      }
    }

    if (longestDuration >= 4) {
      quietStart = longestStart;
      quietEnd = (longestStart + longestDuration) % 24;
    }

    return { start: quietStart, end: quietEnd };
  }

  /**
   * Get activity heatmap (all 168 slots)
   */
  getActivityHeatmap(): TimeSlot[][] {
    const rows = this.db
      .query<{
        hour: number;
        day_of_week: number;
        interaction_count: number;
      }, []>(
        `SELECT hour, day_of_week, interaction_count
         FROM user_activity_patterns
         ORDER BY day_of_week, hour`
      )
      .all();

    // Get max for normalization
    const max = Math.max(...rows.map((r) => r.interaction_count), 1);

    // Group by day
    const heatmap: TimeSlot[][] = Array.from({ length: 7 }, () => []);

    for (const row of rows) {
      heatmap[row.day_of_week]!.push({
        hour: row.hour,
        dayOfWeek: row.day_of_week,
        score: row.interaction_count / max,
      });
    }

    return heatmap;
  }

  /**
   * Get stats summary
   */
  getStats(): {
    totalInteractions: number;
    mostActiveHour: number;
    mostActiveDay: number;
    leastActiveHour: number;
  } {
    const total = this.db
      .query<{ total: number }, []>(
        "SELECT SUM(interaction_count) as total FROM user_activity_patterns"
      )
      .get()?.total ?? 0;

    const mostActiveHourRow = this.db
      .query<{ hour: number }, []>(
        `SELECT hour FROM user_activity_patterns
         GROUP BY hour
         ORDER BY SUM(interaction_count) DESC
         LIMIT 1`
      )
      .get();

    const mostActiveDayRow = this.db
      .query<{ day_of_week: number }, []>(
        `SELECT day_of_week FROM user_activity_patterns
         GROUP BY day_of_week
         ORDER BY SUM(interaction_count) DESC
         LIMIT 1`
      )
      .get();

    const leastActiveHourRow = this.db
      .query<{ hour: number }, []>(
        `SELECT hour FROM user_activity_patterns
         WHERE hour BETWEEN 8 AND 22
         GROUP BY hour
         ORDER BY SUM(interaction_count) ASC
         LIMIT 1`
      )
      .get();

    return {
      totalInteractions: total,
      mostActiveHour: mostActiveHourRow?.hour ?? 12,
      mostActiveDay: mostActiveDayRow?.day_of_week ?? 0,
      leastActiveHour: leastActiveHourRow?.hour ?? 14,
    };
  }
}

// Factory function to get ActivityPatternService for a user
const activityServices = new Map<number, ActivityPatternService>();

export async function getActivityPatternService(userId: number): Promise<ActivityPatternService> {
  let service = activityServices.get(userId);
  if (!service) {
    const db = await userManager.getUserDb(userId);
    service = new ActivityPatternService(db, userId);
    activityServices.set(userId, service);
  }
  return service;
}

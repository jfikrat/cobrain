/**
 * Mood Tracking Service - Automatic mood inference and tracking
 * Cobrain v0.7 - Proactive Level 3
 */

import { Database } from "bun:sqlite";
import { userManager } from "./user-manager.ts";

export type MoodType = "great" | "good" | "neutral" | "low" | "bad";
export type MoodSource = "inferred" | "explicit";

export interface MoodEntry {
  id: number;
  mood: MoodType;
  energy: number; // 1-5
  context?: string;
  triggers: string[];
  source: MoodSource;
  confidence: number; // 0.0-1.0
  createdAt: string;
}

export interface MoodInput {
  mood: MoodType;
  energy?: number;
  context?: string;
  triggers?: string[];
  source?: MoodSource;
  confidence?: number;
}

export interface MoodTrend {
  direction: "improving" | "stable" | "declining";
  averageMood: number; // 1-5 scale
  averageEnergy: number;
  dataPoints: number;
  startDate: string;
  endDate: string;
}

// Mood to numeric value mapping
const MOOD_VALUES: Record<MoodType, number> = {
  great: 5,
  good: 4,
  neutral: 3,
  low: 2,
  bad: 1,
};

export class MoodTrackingService {
  private db: Database;
  private userId: number;

  constructor(userDb: Database, userId: number) {
    this.db = userDb;
    this.userId = userId;
    this.initTable();
  }

  private initTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mood_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mood TEXT NOT NULL CHECK(mood IN ('great', 'good', 'neutral', 'low', 'bad')),
        energy INTEGER DEFAULT 3 CHECK(energy BETWEEN 1 AND 5),
        context TEXT,
        triggers TEXT DEFAULT '[]',
        source TEXT DEFAULT 'inferred' CHECK(source IN ('inferred', 'explicit')),
        confidence REAL DEFAULT 0.5,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_mood_created ON mood_entries(created_at DESC)`);
  }

  /**
   * Record a mood entry
   */
  recordMood(input: MoodInput): number {
    const result = this.db.run(
      `INSERT INTO mood_entries (mood, energy, context, triggers, source, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.mood,
        input.energy ?? 3,
        input.context ?? null,
        JSON.stringify(input.triggers ?? []),
        input.source ?? "inferred",
        input.confidence ?? 0.5,
      ]
    );

    const id = Number(result.lastInsertRowid);
    console.log(`[MoodTracking] Recorded #${id}: ${input.mood} (${input.source}, confidence: ${input.confidence})`);
    return id;
  }

  /**
   * Get mood history for the last N days
   */
  getMoodHistory(days: number = 7): MoodEntry[] {
    const rows = this.db
      .query<{
        id: number;
        mood: string;
        energy: number;
        context: string | null;
        triggers: string;
        source: string;
        confidence: number;
        created_at: string;
      }, [string]>(
        `SELECT * FROM mood_entries
         WHERE created_at >= datetime('now', ?)
         ORDER BY created_at DESC`
      )
      .all(`-${days} days`);

    return rows.map((row) => ({
      id: row.id,
      mood: row.mood as MoodType,
      energy: row.energy,
      context: row.context ?? undefined,
      triggers: JSON.parse(row.triggers || "[]"),
      source: row.source as MoodSource,
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get mood trend analysis for the last N days
   */
  getMoodTrend(days: number = 7): MoodTrend {
    const history = this.getMoodHistory(days);

    if (history.length === 0) {
      return {
        direction: "stable",
        averageMood: 3,
        averageEnergy: 3,
        dataPoints: 0,
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString(),
      };
    }

    // Calculate averages
    const totalMood = history.reduce((sum, entry) => sum + MOOD_VALUES[entry.mood], 0);
    const totalEnergy = history.reduce((sum, entry) => sum + entry.energy, 0);
    const averageMood = totalMood / history.length;
    const averageEnergy = totalEnergy / history.length;

    // Calculate trend direction
    let direction: "improving" | "stable" | "declining" = "stable";

    if (history.length >= 3) {
      // Compare first half vs second half averages
      const halfPoint = Math.floor(history.length / 2);
      const recentHalf = history.slice(0, halfPoint);
      const olderHalf = history.slice(halfPoint);

      const recentAvg = recentHalf.reduce((sum, e) => sum + MOOD_VALUES[e.mood], 0) / recentHalf.length;
      const olderAvg = olderHalf.reduce((sum, e) => sum + MOOD_VALUES[e.mood], 0) / olderHalf.length;

      const diff = recentAvg - olderAvg;
      if (diff > 0.5) {
        direction = "improving";
      } else if (diff < -0.5) {
        direction = "declining";
      }
    }

    return {
      direction,
      averageMood,
      averageEnergy,
      dataPoints: history.length,
      startDate: history[history.length - 1]?.createdAt ?? new Date().toISOString(),
      endDate: history[0]?.createdAt ?? new Date().toISOString(),
    };
  }

  /**
   * Get average mood and energy for the last N days
   */
  getAverageMood(days: number = 7): { mood: number; energy: number } {
    const trend = this.getMoodTrend(days);
    return {
      mood: trend.averageMood,
      energy: trend.averageEnergy,
    };
  }

  /**
   * Get mood breakdown by time of day
   */
  getMoodByTimeOfDay(): Record<string, number> {
    const rows = this.db
      .query<{
        hour_group: string;
        avg_mood: number;
      }, []>(
        `SELECT
          CASE
            WHEN CAST(strftime('%H', created_at) AS INTEGER) BETWEEN 6 AND 11 THEN 'morning'
            WHEN CAST(strftime('%H', created_at) AS INTEGER) BETWEEN 12 AND 16 THEN 'afternoon'
            WHEN CAST(strftime('%H', created_at) AS INTEGER) BETWEEN 17 AND 21 THEN 'evening'
            ELSE 'night'
          END as hour_group,
          AVG(CASE mood
            WHEN 'great' THEN 5
            WHEN 'good' THEN 4
            WHEN 'neutral' THEN 3
            WHEN 'low' THEN 2
            WHEN 'bad' THEN 1
          END) as avg_mood
         FROM mood_entries
         WHERE created_at >= datetime('now', '-30 days')
         GROUP BY hour_group`
      )
      .all();

    const result: Record<string, number> = {
      morning: 3,
      afternoon: 3,
      evening: 3,
      night: 3,
    };

    for (const row of rows) {
      result[row.hour_group] = row.avg_mood;
    }

    return result;
  }

  /**
   * Get the most recent mood entry
   */
  getCurrentMood(): MoodEntry | null {
    const row = this.db
      .query<{
        id: number;
        mood: string;
        energy: number;
        context: string | null;
        triggers: string;
        source: string;
        confidence: number;
        created_at: string;
      }, []>(
        `SELECT * FROM mood_entries ORDER BY created_at DESC LIMIT 1`
      )
      .get();

    if (!row) return null;

    return {
      id: row.id,
      mood: row.mood as MoodType,
      energy: row.energy,
      context: row.context ?? undefined,
      triggers: JSON.parse(row.triggers || "[]"),
      source: row.source as MoodSource,
      confidence: row.confidence,
      createdAt: row.created_at,
    };
  }

  /**
   * Get mood stats
   */
  getStats(): {
    total: number;
    byMood: Record<MoodType, number>;
    averageEnergy: number;
    lastEntry: string | null;
  } {
    const total = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM mood_entries")
      .get()?.count ?? 0;

    const byMood: Record<MoodType, number> = {
      great: 0,
      good: 0,
      neutral: 0,
      low: 0,
      bad: 0,
    };

    const moodCounts = this.db
      .query<{ mood: string; count: number }, []>(
        "SELECT mood, COUNT(*) as count FROM mood_entries GROUP BY mood"
      )
      .all();

    for (const row of moodCounts) {
      byMood[row.mood as MoodType] = row.count;
    }

    const avgEnergy = this.db
      .query<{ avg: number }, []>("SELECT AVG(energy) as avg FROM mood_entries")
      .get()?.avg ?? 3;

    const lastEntry = this.db
      .query<{ created_at: string }, []>(
        "SELECT created_at FROM mood_entries ORDER BY created_at DESC LIMIT 1"
      )
      .get()?.created_at ?? null;

    return {
      total,
      byMood,
      averageEnergy: avgEnergy,
      lastEntry,
    };
  }
}

// Factory function to get MoodTrackingService for a user
const moodServices = new Map<number, MoodTrackingService>();

export async function getMoodTrackingService(userId: number): Promise<MoodTrackingService> {
  let service = moodServices.get(userId);
  if (!service) {
    const db = await userManager.getUserDb(userId);
    service = new MoodTrackingService(db, userId);
    moodServices.set(userId, service);
  }
  return service;
}

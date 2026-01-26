import { Database } from "bun:sqlite";
import { config } from "../config.ts";

export interface Message {
  id: number;
  userId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

class Memory {
  private db: Database;

  constructor() {
    this.db = new Database(config.DB_PATH, { create: true });
    this.init();
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS preferences (
        user_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_messages_user_id
      ON messages(user_id)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  addMessage(userId: number, role: "user" | "assistant", content: string): void {
    this.db.run(
      "INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)",
      [userId, role, content]
    );
  }

  getHistory(userId: number, limit: number = config.MAX_HISTORY): Message[] {
    const rows = this.db
      .query<
        { id: number; user_id: number; role: string; content: string; created_at: string },
        [number, number]
      >(
        `SELECT id, user_id, role, content, created_at
         FROM messages
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(userId, limit);

    return rows
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        role: row.role as "user" | "assistant",
        content: row.content,
        createdAt: row.created_at,
      }))
      .reverse();
  }

  clearHistory(userId: number): number {
    const result = this.db.run("DELETE FROM messages WHERE user_id = ?", [userId]);
    return result.changes;
  }

  getPreferences(userId: number): Record<string, unknown> {
    const row = this.db
      .query<{ data: string }, [number]>("SELECT data FROM preferences WHERE user_id = ?")
      .get(userId);

    return row ? JSON.parse(row.data) : {};
  }

  setPreferences(userId: number, data: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO preferences (user_id, data, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         data = excluded.data,
         updated_at = CURRENT_TIMESTAMP`,
      [userId, JSON.stringify(data)]
    );
  }

  // ========== SESSION METHODS ==========

  getSession(userId: number): string | null {
    const row = this.db
      .query<{ session_id: string }, [number]>(
        "SELECT session_id FROM sessions WHERE user_id = ?"
      )
      .get(userId);

    if (row) {
      // last_used_at güncelle
      this.db.run(
        "UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ?",
        [userId]
      );
    }

    return row?.session_id ?? null;
  }

  setSession(userId: number, sessionId: string): void {
    this.db.run(
      `INSERT INTO sessions (user_id, session_id, created_at, last_used_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         session_id = excluded.session_id,
         created_at = CURRENT_TIMESTAMP,
         last_used_at = CURRENT_TIMESTAMP`,
      [userId, sessionId]
    );
  }

  clearSession(userId: number): void {
    this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }

  // ========== STATS ==========

  getStats(): { messageCount: number; userCount: number } {
    const messageCount = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages")
      .get()?.count ?? 0;

    const userCount = this.db
      .query<{ count: number }, []>("SELECT COUNT(DISTINCT user_id) as count FROM messages")
      .get()?.count ?? 0;

    return { messageCount, userCount };
  }

  close(): void {
    this.db.close();
  }
}

export const memory = new Memory();

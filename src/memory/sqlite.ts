/**
 * Per-user SQLite memory storage
 * Cobrain v0.2 - No user_id in tables, each user has their own DB
 */

import { Database } from "bun:sqlite";

export interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Session {
  id: string;
  status: string;
  messageCount: number;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * UserMemory - Per-user database operations
 * Each user has their own instance with isolated data
 */
export class UserMemory {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    // Messages table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sessions table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'active',
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )
    `);

    // Preferences table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)`);

    // Add session_key column for hub agent session persistence
    try {
      this.db.run(`ALTER TABLE sessions ADD COLUMN session_key TEXT DEFAULT NULL`);
    } catch {
      // Column already exists, ignore
    }

  }

  // ========== MESSAGE METHODS ==========

  addMessage(
    role: "user" | "assistant" | "system",
    content: string,
    options?: { tokensIn?: number; tokensOut?: number; costUsd?: number; metadata?: Record<string, unknown> }
  ): number {
    const result = this.db.run(
      `INSERT INTO messages (role, content, tokens_in, tokens_out, cost_usd, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        role,
        content,
        options?.tokensIn ?? 0,
        options?.tokensOut ?? 0,
        options?.costUsd ?? 0,
        JSON.stringify(options?.metadata ?? {}),
      ]
    );
    return Number(result.lastInsertRowid);
  }

  getHistory(limit: number = 10): Message[] {
    const rows = this.db
      .query<
        {
          id: number;
          role: string;
          content: string;
          tokens_in: number;
          tokens_out: number;
          cost_usd: number;
          metadata: string;
          created_at: string;
        },
        [number]
      >(
        `SELECT id, role, content, tokens_in, tokens_out, cost_usd, metadata, created_at
         FROM messages
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit);

    return rows
      .map((row) => ({
        id: row.id,
        role: row.role as "user" | "assistant" | "system",
        content: row.content,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        costUsd: row.cost_usd,
        metadata: JSON.parse(row.metadata || "{}"),
        createdAt: row.created_at,
      }))
      .reverse();
  }

  clearHistory(): number {
    const result = this.db.run("DELETE FROM messages");
    return result.changes;
  }

  // ========== SESSION METHODS ==========

  getSession(): Session | null {
    const row = this.db
      .query<
        { id: string; status: string; message_count: number; created_at: string; last_used_at: string | null },
        []
      >("SELECT * FROM sessions WHERE status = 'active' ORDER BY last_used_at DESC LIMIT 1")
      .get();

    if (row) {
      // Update last_used_at
      this.db.run("UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);

      return {
        id: row.id,
        status: row.status,
        messageCount: row.message_count,
        createdAt: row.created_at,
        lastUsedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  getSessionId(): string | null {
    return this.getSession()?.id ?? null;
  }

  createSession(sessionId: string): void {
    this.db.run(
      `INSERT INTO sessions (id, status, last_used_at) VALUES (?, 'active', CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET status = 'active', last_used_at = CURRENT_TIMESTAMP`,
      [sessionId]
    );
  }

  setSession(sessionId: string): void {
    // Mark all existing sessions as inactive
    this.db.run("UPDATE sessions SET status = 'inactive' WHERE status = 'active'");
    // Create new active session
    this.createSession(sessionId);
  }

  incrementSessionMessageCount(): void {
    this.db.run(
      "UPDATE sessions SET message_count = message_count + 1 WHERE status = 'active'"
    );
  }

  clearSession(): void {
    this.db.run("UPDATE sessions SET status = 'inactive' WHERE status = 'active'");
  }

  // ========== KEYED SESSION METHODS (hub agents) ==========

  getSessionByKey(key: string): Session | null {
    const row = this.db
      .query<
        { id: string; status: string; message_count: number; created_at: string; last_used_at: string | null },
        [string]
      >("SELECT * FROM sessions WHERE status = 'active' AND session_key = ? ORDER BY last_used_at DESC LIMIT 1")
      .get(key);

    if (row) {
      this.db.run("UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
      return {
        id: row.id,
        status: row.status,
        messageCount: row.message_count,
        createdAt: row.created_at,
        lastUsedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  setSessionByKey(key: string, sessionId: string): void {
    // Deactivate previous active session for this key
    this.db.run("UPDATE sessions SET status = 'inactive' WHERE status = 'active' AND session_key = ?", [key]);
    // Insert new active session with key
    this.db.run(
      `INSERT INTO sessions (id, session_key, status, last_used_at) VALUES (?, ?, 'active', CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET session_key = ?, status = 'active', last_used_at = CURRENT_TIMESTAMP`,
      [sessionId, key, key]
    );
  }

  clearSessionByKey(key: string): void {
    this.db.run("UPDATE sessions SET status = 'inactive' WHERE status = 'active' AND session_key = ?", [key]);
  }

  // ========== PREFERENCES METHODS ==========

  getPreference(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM preferences WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setPreference(key: string, value: string): void {
    this.db.run(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, value]
    );
  }

  getPreferences(): Record<string, string> {
    const rows = this.db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM preferences")
      .all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ========== STATS ==========

  getStats(): { messageCount: number; sessionCount: number; totalCost: number } {
    const messageCount =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages").get()?.count ?? 0;

    const sessionCount =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM sessions").get()?.count ?? 0;

    const totalCost =
      this.db.query<{ total: number }, []>("SELECT COALESCE(SUM(cost_usd), 0) as total FROM messages").get()?.total ??
      0;

    return { messageCount, sessionCount, totalCost };
  }

  close(): void {
    this.db.close();
  }
}

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

/** Web UI conversation row type */
interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  is_deleted: number;
}

/** Web UI conversation message row type */
interface ConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_uses: string;
  attachments: string;
  timestamp: number;
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

    // Web UI Conversations table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'Yeni Sohbet',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_deleted INTEGER DEFAULT 0
      )
    `);

    // Web UI Conversation Messages table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        tool_uses TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);

    // Add attachments column if it doesn't exist (migration for existing DBs)
    try {
      this.db.run(`ALTER TABLE conversation_messages ADD COLUMN attachments TEXT DEFAULT '[]'`);
    } catch {
      // Column already exists, ignore
    }

    // Add session_key column for hub agent session persistence
    try {
      this.db.run(`ALTER TABLE sessions ADD COLUMN session_key TEXT DEFAULT NULL`);
    } catch {
      // Column already exists, ignore
    }

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_messages ON conversation_messages(conversation_id, timestamp)`);
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

  // ========== WEB UI CONVERSATION METHODS ==========

  /**
   * Get all conversations updated since timestamp
   */
  getConversationsSince(sinceTimestamp: number | null): Array<{
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      toolUses: unknown[];
      timestamp: number;
    }>;
  }> {
    const whereClause = sinceTimestamp !== null
      ? `WHERE is_deleted = 0 AND updated_at > ?`
      : `WHERE is_deleted = 0`;

    const params = sinceTimestamp !== null ? [sinceTimestamp] : [];

    const conversations = this.db
      .query<ConversationRow, number[]>(
        `SELECT id, title, created_at, updated_at, is_deleted FROM conversations ${whereClause} ORDER BY updated_at DESC`
      )
      .all(...params);

    return conversations.map((conv) => {
      const messages = this.db
        .query<ConversationMessageRow, [string]>(
          `SELECT id, conversation_id, role, content, tool_uses, attachments, timestamp FROM conversation_messages WHERE conversation_id = ? ORDER BY timestamp ASC`
        )
        .all(conv.id);

      return {
        id: conv.id,
        title: conv.title,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        messages: messages.map((msg) => ({
          id: msg.id,
          role: msg.role as "user" | "assistant",
          content: msg.content,
          toolUses: JSON.parse(msg.tool_uses || "[]"),
          attachments: JSON.parse(msg.attachments || "[]"),
          timestamp: msg.timestamp,
        })),
      };
    });
  }

  /**
   * Get all conversations (for full sync)
   */
  getAllConversations() {
    return this.getConversationsSince(null);
  }

  /**
   * Create a new conversation
   */
  createConversation(id: string, title: string, createdAt: number): void {
    this.db.run(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      [id, title, createdAt, createdAt]
    );
  }

  /**
   * Update conversation title
   */
  updateConversationTitle(id: string, title: string): void {
    this.db.run(
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
      [title, Date.now(), id]
    );
  }

  /**
   * Soft delete a conversation
   */
  deleteConversation(id: string): void {
    this.db.run(
      `UPDATE conversations SET is_deleted = 1, updated_at = ? WHERE id = ?`,
      [Date.now(), id]
    );
  }

  /**
   * Save a message to a conversation
   */
  saveConversationMessage(
    conversationId: string,
    message: {
      id: string;
      role: "user" | "assistant";
      content: string;
      toolUses?: unknown[];
      attachments?: unknown[];
      timestamp: number;
    }
  ): void {
    // Ensure conversation exists
    const exists = this.db
      .query<{ id: string }, [string]>(`SELECT id FROM conversations WHERE id = ?`)
      .get(conversationId);

    if (!exists) {
      // Create conversation with default title
      this.createConversation(conversationId, "Yeni Sohbet", message.timestamp);
    }

    // Insert or update message
    this.db.run(
      `INSERT INTO conversation_messages (id, conversation_id, role, content, tool_uses, attachments, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, tool_uses = excluded.tool_uses, attachments = excluded.attachments`,
      [
        message.id,
        conversationId,
        message.role,
        message.content,
        JSON.stringify(message.toolUses || []),
        JSON.stringify(message.attachments || []),
        message.timestamp,
      ]
    );

    // Update conversation timestamp
    this.db.run(
      `UPDATE conversations SET updated_at = ? WHERE id = ?`,
      [Date.now(), conversationId]
    );
  }

  /**
   * Update conversation title based on first user message
   */
  autoTitleConversation(conversationId: string, userMessage: string): void {
    const conv = this.db
      .query<{ title: string }, [string]>(`SELECT title FROM conversations WHERE id = ?`)
      .get(conversationId);

    if (conv && conv.title === "Yeni Sohbet") {
      const newTitle = userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : "");
      this.updateConversationTitle(conversationId, newTitle);
    }
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

/**
 * Legacy Memory class - For backwards compatibility during migration
 * @deprecated Use UserMemory with UserManager instead
 */
export class Memory {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init(): void {
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

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)`);

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
    this.db.run("INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)", [userId, role, content]);
  }

  getHistory(userId: number, limit: number = 10): Message[] {
    const rows = this.db
      .query<{ id: number; role: string; content: string; created_at: string }, [number, number]>(
        `SELECT id, role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(userId, limit);

    return rows
      .map((row) => ({
        id: row.id,
        role: row.role as "user" | "assistant",
        content: row.content,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        metadata: {},
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
      `INSERT INTO preferences (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
      [userId, JSON.stringify(data)]
    );
  }

  getSession(userId: number): string | null {
    const row = this.db
      .query<{ session_id: string }, [number]>("SELECT session_id FROM sessions WHERE user_id = ?")
      .get(userId);

    if (row) {
      this.db.run("UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = ?", [userId]);
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

  getStats(): { messageCount: number; userCount: number } {
    const messageCount =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages").get()?.count ?? 0;

    const userCount =
      this.db.query<{ count: number }, []>("SELECT COUNT(DISTINCT user_id) as count FROM messages").get()?.count ?? 0;

    return { messageCount, userCount };
  }

  /**
   * Get all unique user IDs (for migration)
   */
  getAllUserIds(): number[] {
    const rows = this.db
      .query<{ user_id: number }, []>("SELECT DISTINCT user_id FROM messages")
      .all();
    return rows.map((r) => r.user_id);
  }

  /**
   * Get raw database instance (for migration)
   */
  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

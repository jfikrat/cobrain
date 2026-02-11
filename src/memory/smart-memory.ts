/**
 * Smart Memory - Haiku-powered semantic memory with FTS5 search
 * Uses Claude Haiku for tag extraction and SQLite FTS5 for full-text search
 * Cobrain v0.3
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  isHaikuAvailable,
  extractTags,
  summarize,
  rankMemories,
} from "../services/haiku.ts";
import type {
  MemoryEntry,
  MemoryInput,
  MemorySearchResult,
  MemoryStats,
  MemoryType,
} from "../types/memory.ts";
import { config } from "../config.ts";

export class SmartMemory {
  private db: Database;
  private userId: number;

  constructor(userFolderPath: string, userId: number) {
    this.userId = userId;
    const dbPath = join(userFolderPath, "memory.db");
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  private init(): void {
    // Main memory table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        content TEXT NOT NULL,
        summary TEXT,
        tags TEXT,
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed_at DATETIME,
        source TEXT,
        source_ref TEXT,
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_mem_tags ON memories(tags)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_mem_expires ON memories(expires_at)`);

    // FTS5 Virtual Table for full-text search
    this.initFTS5();
  }

  /**
   * Initialize FTS5 virtual table and triggers
   */
  private initFTS5(): void {
    // Check if FTS5 table exists
    const ftsExists = this.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
      )
      .get();

    if (!ftsExists) {
      console.log(`[SmartMemory] Creating FTS5 virtual table (user: ${this.userId})`);

      // Create FTS5 virtual table
      this.db.run(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          summary,
          tags,
          content=memories,
          content_rowid=id
        )
      `);

      // Sync triggers for INSERT
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, summary, tags)
          VALUES (NEW.id, NEW.content, NEW.summary, NEW.tags);
        END
      `);

      // Sync triggers for DELETE
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
          VALUES('delete', OLD.id, OLD.content, OLD.summary, OLD.tags);
        END
      `);

      // Sync triggers for UPDATE
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags)
          VALUES('delete', OLD.id, OLD.content, OLD.summary, OLD.tags);
          INSERT INTO memories_fts(rowid, content, summary, tags)
          VALUES (NEW.id, NEW.content, NEW.summary, NEW.tags);
        END
      `);

      // Migrate existing data to FTS5
      this.rebuildFTS5();
    }
  }

  /**
   * Rebuild FTS5 index from existing memories
   */
  private rebuildFTS5(): void {
    const existingCount = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories")
      .get()?.count ?? 0;

    if (existingCount > 0) {
      console.log(`[SmartMemory] Migrating ${existingCount} existing memories to FTS5`);

      // Rebuild FTS5 index
      this.db.run(`
        INSERT INTO memories_fts(rowid, content, summary, tags)
        SELECT id, content, summary, tags FROM memories
      `);

      console.log(`[SmartMemory] FTS5 migration complete`);
    }
  }

  /**
   * Store a new memory with auto-generated tags and summary
   */
  async store(input: MemoryInput): Promise<number> {
    let tags: string[] = [];
    let summary = input.summary;

    // Use Haiku to extract tags and generate summary
    if (isHaikuAvailable()) {
      try {
        tags = await extractTags(input.content);

        if (!summary && input.content.length > 100) {
          summary = await summarize(input.content, 15);
        }
      } catch (error) {
        console.warn("[SmartMemory] Haiku extraction failed:", error);
      }
    }

    // Fallback: simple keyword extraction
    if (tags.length === 0) {
      tags = this.simpleExtractTags(input.content);
    }

    if (!summary) {
      summary = input.content.slice(0, 100);
    }

    // Calculate expiration
    let expiresAt: string | null = input.expiresAt ?? null;
    if (!expiresAt && input.type === "episodic") {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + config.MAX_MEMORY_AGE_DAYS);
      expiresAt = expDate.toISOString();
    }

    const result = this.db.run(
      `INSERT INTO memories (type, content, summary, tags, importance, source, source_ref, metadata, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.type,
        input.content,
        summary,
        tags.join(","),
        input.importance ?? 0.5,
        input.source ?? null,
        input.sourceRef ?? null,
        JSON.stringify(input.metadata ?? {}),
        expiresAt,
      ]
    );

    const id = Number(result.lastInsertRowid);
    console.log(`[SmartMemory] Stored #${id} (${input.type}) tags: ${tags.join(", ")}`);

    return id;
  }

  /**
   * Search memories using FTS5 + optional Haiku semantic ranking
   */
  async search(query: string, options?: {
    type?: MemoryType;
    limit?: number;
    minScore?: number;
  }): Promise<MemorySearchResult[]> {
    const limit = options?.limit ?? 5;
    const minScore = options?.minScore ?? 0.3;

    // First, get candidates using FTS5
    const candidates = this.fts5Search(query, options?.type, 20);

    if (candidates.length === 0) {
      return [];
    }

    // If Haiku is available, rank semantically
    if (isHaikuAvailable()) {
      try {
        const ranked = await rankMemories(
          query,
          candidates.map((c) => ({ id: c.id, content: c.content, summary: c.summary })),
          limit
        );

        const results: MemorySearchResult[] = [];

        for (const r of ranked) {
          if (r.score < minScore) continue;

          const memory = candidates.find((c) => c.id === r.id);
          if (memory) {
            results.push({ ...memory, similarity: r.score });

            // Update access count
            this.db.run(
              "UPDATE memories SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?",
              [memory.id]
            );
          }
        }

        return results;
      } catch (error) {
        console.warn("[SmartMemory] Haiku ranking failed, using FTS5 results:", error);
      }
    }

    // Fallback: return FTS5 results with estimated scores
    return candidates.slice(0, limit).map((c) => ({
      ...c,
      similarity: 0.5,
    }));
  }

  /**
   * FTS5-based full-text search
   */
  private fts5Search(query: string, type?: MemoryType, limit: number = 10): MemoryEntry[] {
    // Prepare FTS5 query - OR between keywords
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 2)
      .map((k) => `"${k}"*`) // Prefix search with quotes for safety
      .join(" OR ");

    if (!keywords) {
      console.log(`[SmartMemory] No valid keywords for FTS5 search`);
      return [];
    }

    console.log(`[SmartMemory] FTS5 search: ${keywords}`);

    let whereClause = "(expires_at IS NULL OR expires_at > datetime('now'))";
    const params: (string | number)[] = [];

    if (type) {
      whereClause += " AND m.type = ?";
      params.push(type);
    }

    params.push(limit);

    try {
      const rows = this.db
        .query<{
          id: number;
          type: string;
          content: string;
          summary: string | null;
          tags: string | null;
          importance: number;
          access_count: number;
          last_accessed_at: string | null;
          source: string | null;
          source_ref: string | null;
          metadata: string;
          created_at: string;
          expires_at: string | null;
          rank: number;
        }, (string | number)[]>(
          `SELECT m.*, bm25(memories_fts) as rank
           FROM memories m
           JOIN memories_fts ON memories_fts.rowid = m.id
           WHERE memories_fts MATCH '${keywords}' AND ${whereClause}
           ORDER BY bm25(memories_fts)
           LIMIT ?`
        )
        .all(...params);

      console.log(`[SmartMemory] FTS5 candidates found: ${rows.length}`);

      return rows.map((row) => ({
        id: row.id,
        vectorRowid: 0, // Not used in smart memory
        type: row.type as MemoryType,
        content: row.content,
        summary: row.summary ?? undefined,
        importance: row.importance,
        accessCount: row.access_count,
        lastAccessedAt: row.last_accessed_at ?? undefined,
        source: row.source ?? undefined,
        sourceRef: row.source_ref ?? undefined,
        metadata: JSON.parse(row.metadata || "{}"),
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? undefined,
      }));
    } catch (error) {
      // FTS5 query failed, fallback to keyword search
      console.warn(`[SmartMemory] FTS5 query failed, falling back to LIKE:`, error);
      return this.keywordSearch(query, type, limit);
    }
  }

  /**
   * Fallback keyword-based search (LIKE)
   */
  private keywordSearch(query: string, type?: MemoryType, limit: number = 10): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 2);
    console.log(`[SmartMemory] Keyword fallback: [${keywords.join(", ")}]`);

    let whereClause = "(expires_at IS NULL OR expires_at > datetime('now'))";
    const params: (string | number)[] = [];

    if (type) {
      whereClause += " AND type = ?";
      params.push(type);
    }

    // Build keyword matching
    if (keywords.length > 0) {
      const keywordConditions = keywords.map(() => "(tags LIKE ? OR content LIKE ? OR summary LIKE ?)");
      whereClause += ` AND (${keywordConditions.join(" OR ")})`;

      for (const kw of keywords) {
        params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
      }
    }

    params.push(limit);

    const rows = this.db
      .query<{
        id: number;
        type: string;
        content: string;
        summary: string | null;
        tags: string | null;
        importance: number;
        access_count: number;
        last_accessed_at: string | null;
        source: string | null;
        source_ref: string | null;
        metadata: string;
        created_at: string;
        expires_at: string | null;
      }, (string | number)[]>(
        `SELECT * FROM memories WHERE ${whereClause} ORDER BY importance DESC, access_count DESC, created_at DESC LIMIT ?`
      )
      .all(...params);

    console.log(`[SmartMemory] Keyword fallback candidates: ${rows.length}`);

    return rows.map((row) => ({
      id: row.id,
      vectorRowid: 0,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /**
   * Simple tag extraction without AI
   */
  private simpleExtractTags(text: string): string[] {
    const stopWords = new Set([
      "bir", "bu", "şu", "ve", "veya", "ile", "için", "de", "da", "mi", "mu",
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "shall", "can", "need", "dare",
      "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\sğüşıöçĞÜŞİÖÇ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    // Count frequency
    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // Return top 5 by frequency
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * Extract and store from conversation
   */
  async extractAndStore(
    conversation: { role: string; content: string }[],
    sessionId?: string
  ): Promise<number> {
    const userMessages = conversation
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ");

    if (userMessages.length < 30) return 0;

    // Check for important content
    const importanceKeywords = [
      "benim", "ben", "favori", "seviyorum", "sevmiyorum",
      "istiyorum", "istemiyorum", "öğreniyorum", "çalışıyorum",
      "hatırla", "unutma", "önemli", "her zaman", "asla",
      "adım", "yaşım", "işim", "hobim", "my", "i am", "i like",
    ];

    const hasImportant = importanceKeywords.some((kw) =>
      userMessages.toLowerCase().includes(kw)
    );

    if (!hasImportant) return 0;

    const lastUser = conversation.filter((m) => m.role === "user").pop()?.content ?? "";
    const lastAssistant = conversation.filter((m) => m.role === "assistant").pop()?.content ?? "";

    return this.store({
      type: "episodic",
      content: `Kullanıcı: ${lastUser}\nAsistan: ${lastAssistant.slice(0, 300)}`,
      importance: 0.6,
      source: "conversation",
      sourceRef: sessionId,
    });
  }

  /**
   * Get recent memories
   */
  getRecent(limit: number = 10): MemoryEntry[] {
    const rows = this.db
      .query<{
        id: number;
        type: string;
        content: string;
        summary: string | null;
        tags: string | null;
        importance: number;
        access_count: number;
        last_accessed_at: string | null;
        source: string | null;
        source_ref: string | null;
        metadata: string;
        created_at: string;
        expires_at: string | null;
      }, [number]>("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?")
      .all(limit);

    return rows.map((row) => ({
      id: row.id,
      vectorRowid: 0,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /**
   * Prune expired memories
   */
  prune(): number {
    const result = this.db.run(
      "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    );
    if (result.changes > 0) {
      console.log(`[SmartMemory] Pruned ${result.changes} expired memories`);
    }
    return result.changes;
  }

  /**
   * Get statistics
   */
  getStats(): MemoryStats {
    const total =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories").get()?.count ?? 0;

    const episodic =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories WHERE type = 'episodic'").get()?.count ?? 0;

    const semantic =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories WHERE type = 'semantic'").get()?.count ?? 0;

    const procedural =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM memories WHERE type = 'procedural'").get()?.count ?? 0;

    const avgImportance =
      this.db.query<{ avg: number }, []>("SELECT AVG(importance) as avg FROM memories").get()?.avg ?? 0;

    const oldest =
      this.db.query<{ created_at: string }, []>("SELECT created_at FROM memories ORDER BY created_at ASC LIMIT 1").get()?.created_at ?? null;

    const newest =
      this.db.query<{ created_at: string }, []>("SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1").get()?.created_at ?? null;

    return {
      total,
      byType: { episodic, semantic, procedural },
      avgImportance,
      oldestEntry: oldest,
      newestEntry: newest,
    };
  }

  /**
   * Delete a memory
   */
  delete(memoryId: number): boolean {
    const result = this.db.run("DELETE FROM memories WHERE id = ?", [memoryId]);
    return result.changes > 0;
  }

  /**
   * Update metadata on an existing memory (merge by default)
   */
  updateMetadata(
    memoryId: number,
    metadata: Record<string, unknown>,
    merge: boolean = true,
  ): boolean {
    if (merge) {
      const row = this.db
        .query<{ metadata: string }, [number]>(
          "SELECT metadata FROM memories WHERE id = ?",
        )
        .get(memoryId);
      if (!row) return false;
      const merged = { ...JSON.parse(row.metadata || "{}"), ...metadata };
      const result = this.db.run(
        "UPDATE memories SET metadata = ? WHERE id = ?",
        [JSON.stringify(merged), memoryId],
      );
      return result.changes > 0;
    }
    const result = this.db.run(
      "UPDATE memories SET metadata = ? WHERE id = ?",
      [JSON.stringify(metadata), memoryId],
    );
    return result.changes > 0;
  }

  /**
   * Find follow-up opportunities based on recent memories
   * Looks for topics that might warrant a check-in
   */
  findFollowupOpportunities(daysBack: number = 7): FollowupCandidate[] {
    const rows = this.db
      .query<{
        id: number;
        content: string;
        summary: string | null;
        tags: string | null;
        importance: number;
        created_at: string;
        type: string;
      }, [string]>(
        `SELECT id, content, summary, tags, importance, created_at, type
         FROM memories
         WHERE created_at >= datetime('now', ?)
         AND importance >= 0.5
         AND type IN ('semantic', 'episodic')
         ORDER BY importance DESC, created_at DESC
         LIMIT 20`
      )
      .all(`-${daysBack} days`);

    const candidates: FollowupCandidate[] = [];

    // Keywords that suggest follow-up opportunities
    const followupKeywords = [
      // Goals/plans
      "hedef", "plan", "yapacak", "öğren", "başla", "bitir",
      "goal", "learn", "start", "finish", "project",
      // Health/wellness
      "egzersiz", "spor", "diyet", "uyku", "sağlık",
      "exercise", "sleep", "health", "diet",
      // Work/study
      "çalış", "okuyorum", "kurs", "eğitim",
      "study", "course", "training", "work",
      // Relationships
      "arkadaş", "aile", "görüş",
      "friend", "family", "meet",
    ];

    for (const row of rows) {
      const content = (row.content + " " + (row.summary || "") + " " + (row.tags || "")).toLowerCase();

      // Check if content matches follow-up keywords
      const matchedKeywords = followupKeywords.filter((kw) => content.includes(kw.toLowerCase()));

      if (matchedKeywords.length > 0) {
        // Calculate days since this memory
        const daysSince = Math.floor(
          (Date.now() - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24)
        );

        // Extract topic from content or summary
        const topic = row.summary || row.content.slice(0, 100);

        candidates.push({
          memoryId: row.id,
          topic,
          keywords: matchedKeywords,
          importance: row.importance,
          daysSince,
          createdAt: row.created_at,
        });
      }
    }

    // Sort by importance * days (older important topics need more follow-up)
    return candidates
      .sort((a, b) => (b.importance * b.daysSince) - (a.importance * a.daysSince))
      .slice(0, 5);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Candidate for memory-based follow-up
 */
export interface FollowupCandidate {
  memoryId: number;
  topic: string;
  keywords: string[];
  importance: number;
  daysSince: number;
  createdAt: string;
}

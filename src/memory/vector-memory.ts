/**
 * Vector Memory using sqlite-vec
 * Cobrain v0.2
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { join } from "node:path";
import { config } from "../config.ts";
import { generateEmbedding, checkOllamaStatus, cosineSimilarity } from "./embeddings.ts";
import type {
  MemoryEntry,
  MemoryInput,
  MemoryQuery,
  MemorySearchResult,
  MemoryStats,
  MemoryType,
  MEMORY_RETENTION,
} from "../types/memory.ts";

export class VectorMemory {
  private db: Database;
  private userId: number;
  private initialized: boolean = false;

  constructor(userFolderPath: string, userId: number) {
    this.userId = userId;
    const dbPath = join(userFolderPath, "memory.db");
    this.db = new Database(dbPath, { create: true });

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    this.init();
  }

  private init(): void {
    if (this.initialized) return;

    // Create vector table for embeddings
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        embedding float[${config.EMBEDDING_DIMENSION}]
      )
    `);

    // Create metadata table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vector_rowid INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('episodic', 'semantic', 'procedural')),
        content TEXT NOT NULL,
        summary TEXT,
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

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_entries(expires_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_entries(importance DESC)`);

    this.initialized = true;
  }

  /**
   * Store a new memory entry
   */
  async store(input: MemoryInput): Promise<number> {
    // Generate embedding
    const embeddingResult = await generateEmbedding(input.content);

    // Insert vector
    const vectorResult = this.db.run(
      "INSERT INTO memory_vectors (embedding) VALUES (?)",
      [embeddingResult.embedding]
    );
    const vectorRowid = Number(vectorResult.lastInsertRowid);

    // Calculate expiration date based on type
    let expiresAt: string | null = input.expiresAt ?? null;
    if (!expiresAt && input.type === "episodic") {
      const expirationDays = config.MAX_MEMORY_AGE_DAYS;
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + expirationDays);
      expiresAt = expDate.toISOString();
    }

    // Insert metadata
    const result = this.db.run(
      `INSERT INTO memory_entries
       (vector_rowid, type, content, summary, importance, source, source_ref, metadata, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vectorRowid,
        input.type,
        input.content,
        input.summary ?? null,
        input.importance ?? 0.5,
        input.source ?? null,
        input.sourceRef ?? null,
        JSON.stringify(input.metadata ?? {}),
        expiresAt,
      ]
    );

    console.log(`[VectorMemory] Stored memory #${result.lastInsertRowid} (${input.type})`);
    return Number(result.lastInsertRowid);
  }

  /**
   * Search for similar memories
   */
  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const isAvailable = await checkOllamaStatus();
    if (!isAvailable) {
      console.warn("[VectorMemory] Ollama not available, falling back to keyword search");
      return this.keywordSearch(query);
    }

    // Generate query embedding
    const embeddingResult = await generateEmbedding(query.query);

    const limit = query.limit ?? 5;
    const minSimilarity = query.minSimilarity ?? 0.5;

    // Vector similarity search
    const vectorResults = this.db
      .query<{ rowid: number; distance: number }, [Float32Array, number]>(
        `SELECT rowid, distance
         FROM memory_vectors
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(embeddingResult.embedding, limit * 2); // Get more results to filter by similarity

    if (vectorResults.length === 0) {
      return [];
    }

    // Get memory entries for matching vectors
    const rowids = vectorResults.map((v) => v.rowid);
    const placeholders = rowids.map(() => "?").join(",");

    // Build WHERE clause
    let whereClause = `vector_rowid IN (${placeholders})`;
    const params: (number | string)[] = [...rowids];

    if (query.type) {
      whereClause += " AND type = ?";
      params.push(query.type);
    }

    if (!query.includeExpired) {
      whereClause += " AND (expires_at IS NULL OR expires_at > datetime('now'))";
    }

    const entries = this.db
      .query<
        {
          id: number;
          vector_rowid: number;
          type: string;
          content: string;
          summary: string | null;
          importance: number;
          access_count: number;
          last_accessed_at: string | null;
          source: string | null;
          source_ref: string | null;
          metadata: string;
          created_at: string;
          expires_at: string | null;
        },
        (number | string)[]
      >(
        `SELECT * FROM memory_entries WHERE ${whereClause}`
      )
      .all(...params);

    // Calculate similarities and filter
    const results: MemorySearchResult[] = [];

    for (const entry of entries) {
      const vectorResult = vectorResults.find((v) => v.rowid === entry.vector_rowid);
      if (!vectorResult) continue;

      // Convert distance to similarity (sqlite-vec uses L2 distance)
      // Similarity = 1 / (1 + distance)
      const similarity = 1 / (1 + vectorResult.distance);

      if (similarity < minSimilarity) continue;

      results.push({
        id: entry.id,
        vectorRowid: entry.vector_rowid,
        type: entry.type as MemoryType,
        content: entry.content,
        summary: entry.summary ?? undefined,
        importance: entry.importance,
        accessCount: entry.access_count,
        lastAccessedAt: entry.last_accessed_at ?? undefined,
        source: entry.source ?? undefined,
        sourceRef: entry.source_ref ?? undefined,
        metadata: JSON.parse(entry.metadata || "{}"),
        createdAt: entry.created_at,
        expiresAt: entry.expires_at ?? undefined,
        similarity,
      });
    }

    // Sort by similarity (highest first) and limit
    results.sort((a, b) => b.similarity - a.similarity);
    const finalResults = results.slice(0, limit);

    // Update access counts
    for (const result of finalResults) {
      this.db.run(
        "UPDATE memory_entries SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
        [result.id]
      );
    }

    return finalResults;
  }

  /**
   * Fallback keyword search when Ollama is not available
   */
  private keywordSearch(query: MemoryQuery): MemorySearchResult[] {
    const limit = query.limit ?? 5;

    let whereClause = "content LIKE ?";
    const params: (string | number)[] = [`%${query.query}%`];

    if (query.type) {
      whereClause += " AND type = ?";
      params.push(query.type);
    }

    if (!query.includeExpired) {
      whereClause += " AND (expires_at IS NULL OR expires_at > datetime('now'))";
    }

    params.push(limit);

    const entries = this.db
      .query<
        {
          id: number;
          vector_rowid: number;
          type: string;
          content: string;
          summary: string | null;
          importance: number;
          access_count: number;
          last_accessed_at: string | null;
          source: string | null;
          source_ref: string | null;
          metadata: string;
          created_at: string;
          expires_at: string | null;
        },
        (string | number)[]
      >(
        `SELECT * FROM memory_entries WHERE ${whereClause} ORDER BY importance DESC, created_at DESC LIMIT ?`
      )
      .all(...params);

    return entries.map((entry) => ({
      id: entry.id,
      vectorRowid: entry.vector_rowid,
      type: entry.type as MemoryType,
      content: entry.content,
      summary: entry.summary ?? undefined,
      importance: entry.importance,
      accessCount: entry.access_count,
      lastAccessedAt: entry.last_accessed_at ?? undefined,
      source: entry.source ?? undefined,
      sourceRef: entry.source_ref ?? undefined,
      metadata: JSON.parse(entry.metadata || "{}"),
      createdAt: entry.created_at,
      expiresAt: entry.expires_at ?? undefined,
      similarity: 0.5, // Unknown similarity for keyword search
    }));
  }

  /**
   * Extract and store important information from a conversation
   */
  async extractAndStore(
    conversation: { role: string; content: string }[],
    sessionId?: string
  ): Promise<number> {
    // Simple extraction: look for personal facts, preferences, important events
    const userMessages = conversation
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");

    if (userMessages.length < 50) {
      return 0; // Too short to extract meaningful info
    }

    // For now, just store the conversation summary as episodic memory
    // In the future, this could use Claude to extract specific facts

    const lastUserMessage = conversation.filter((m) => m.role === "user").pop()?.content ?? "";
    const lastAssistantMessage = conversation.filter((m) => m.role === "assistant").pop()?.content ?? "";

    if (lastUserMessage.length < 20) {
      return 0;
    }

    // Only store if the conversation seems important
    // (contains personal info, questions about preferences, etc.)
    const importanceKeywords = [
      "benim", "ben", "favori", "seviyorum", "sevmiyorum",
      "istiyorum", "istemiyorum", "öğreniyorum", "çalışıyorum",
      "hatırla", "unutma", "önemli", "her zaman", "asla",
      "adım", "yaşım", "işim", "hobim",
    ];

    const hasImportantContent = importanceKeywords.some(
      (kw) => lastUserMessage.toLowerCase().includes(kw)
    );

    if (!hasImportantContent) {
      return 0;
    }

    // Store as episodic memory
    const memoryId = await this.store({
      type: "episodic",
      content: `Kullanıcı: ${lastUserMessage}\nAsistan: ${lastAssistantMessage.slice(0, 500)}`,
      summary: lastUserMessage.slice(0, 200),
      importance: 0.6,
      source: "conversation",
      sourceRef: sessionId,
    });

    return memoryId;
  }

  /**
   * Prune expired memories
   */
  async prune(): Promise<number> {
    // Get expired entries
    const expired = this.db
      .query<{ id: number; vector_rowid: number }, []>(
        "SELECT id, vector_rowid FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
      )
      .all();

    if (expired.length === 0) {
      return 0;
    }

    // Delete from memory_entries
    const entryIds = expired.map((e) => e.id);
    const vectorRowids = expired.map((e) => e.vector_rowid);

    this.db.run(
      `DELETE FROM memory_entries WHERE id IN (${entryIds.map(() => "?").join(",")})`,
      entryIds
    );

    // Delete from memory_vectors
    this.db.run(
      `DELETE FROM memory_vectors WHERE rowid IN (${vectorRowids.map(() => "?").join(",")})`,
      vectorRowids
    );

    console.log(`[VectorMemory] Pruned ${expired.length} expired memories`);
    return expired.length;
  }

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats {
    const total =
      this.db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_entries").get()?.count ?? 0;

    const episodic =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_entries WHERE type = 'episodic'")
        .get()?.count ?? 0;

    const semantic =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_entries WHERE type = 'semantic'")
        .get()?.count ?? 0;

    const procedural =
      this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM memory_entries WHERE type = 'procedural'")
        .get()?.count ?? 0;

    const avgImportance =
      this.db
        .query<{ avg: number }, []>("SELECT AVG(importance) as avg FROM memory_entries")
        .get()?.avg ?? 0;

    const oldest =
      this.db
        .query<{ created_at: string }, []>("SELECT created_at FROM memory_entries ORDER BY created_at ASC LIMIT 1")
        .get()?.created_at ?? null;

    const newest =
      this.db
        .query<{ created_at: string }, []>("SELECT created_at FROM memory_entries ORDER BY created_at DESC LIMIT 1")
        .get()?.created_at ?? null;

    return {
      total,
      byType: { episodic, semantic, procedural },
      avgImportance,
      oldestEntry: oldest,
      newestEntry: newest,
    };
  }

  /**
   * Get recent memories
   */
  getRecent(limit: number = 10): MemoryEntry[] {
    const entries = this.db
      .query<
        {
          id: number;
          vector_rowid: number;
          type: string;
          content: string;
          summary: string | null;
          importance: number;
          access_count: number;
          last_accessed_at: string | null;
          source: string | null;
          source_ref: string | null;
          metadata: string;
          created_at: string;
          expires_at: string | null;
        },
        [number]
      >("SELECT * FROM memory_entries ORDER BY created_at DESC LIMIT ?")
      .all(limit);

    return entries.map((entry) => ({
      id: entry.id,
      vectorRowid: entry.vector_rowid,
      type: entry.type as MemoryType,
      content: entry.content,
      summary: entry.summary ?? undefined,
      importance: entry.importance,
      accessCount: entry.access_count,
      lastAccessedAt: entry.last_accessed_at ?? undefined,
      source: entry.source ?? undefined,
      sourceRef: entry.source_ref ?? undefined,
      metadata: JSON.parse(entry.metadata || "{}"),
      createdAt: entry.created_at,
      expiresAt: entry.expires_at ?? undefined,
    }));
  }

  /**
   * Delete a specific memory
   */
  delete(memoryId: number): boolean {
    const entry = this.db
      .query<{ vector_rowid: number }, [number]>("SELECT vector_rowid FROM memory_entries WHERE id = ?")
      .get(memoryId);

    if (!entry) return false;

    this.db.run("DELETE FROM memory_entries WHERE id = ?", [memoryId]);
    this.db.run("DELETE FROM memory_vectors WHERE rowid = ?", [entry.vector_rowid]);

    return true;
  }

  close(): void {
    this.db.close();
  }
}

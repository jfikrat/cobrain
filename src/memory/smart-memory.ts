/**
 * Smart Memory - Hybrid search: FTS5 + sqlite-vec vector search
 * Uses Claude Haiku for tag extraction, FTS5 for full-text search,
 * and Gemini embeddings for vector similarity (RRF fusion)
 * Cobrain v1.2
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

/** Format a Date as SQLite-compatible UTC string: YYYY-MM-DD HH:MM:SS */
function toSqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Safe JSON.parse with fallback — prevents crashes on corrupted metadata */
function safeParseJson(raw: string | null | undefined, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[SmartMemory] Corrupted JSON metadata, using fallback: ${raw.slice(0, 80)}`);
    return fallback;
  }
}

export class SmartMemory {
  private db: Database;
  private userId: number;
  private vecAvailable = false;

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
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_mem_created_at ON memories(created_at DESC)`);

    // FTS5 Virtual Table for full-text search
    this.initFTS5();

    // Vector search extension (sqlite-vec)
    this.initVec();
  }

  /**
   * Initialize sqlite-vec extension and vector tables
   */
  private initVec(): void {
    try {
      // sqlite-vec is installed at node_modules/sqlite-vec
      // load() is synchronous — calls db.loadExtension() internally
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);
      this.vecAvailable = true;
      console.log(`[SmartMemory] sqlite-vec loaded (user: ${this.userId})`);
    } catch (err) {
      console.warn("[SmartMemory] sqlite-vec not available, vector search disabled:", err);
      this.vecAvailable = false;
      return;
    }

    // Create chunk storage table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_memory ON memory_chunks(memory_id)`);

    // Create vec0 virtual table for cosine similarity search
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[768]
      )
    `);
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

    // Calculate expiration — normalize to SQLite datetime format (YYYY-MM-DD HH:MM:SS)
    let expiresAt: string | null = input.expiresAt
      ? toSqliteDatetime(new Date(input.expiresAt))
      : null;
    if (!expiresAt && input.type === "episodic") {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + config.MAX_MEMORY_AGE_DAYS);
      expiresAt = toSqliteDatetime(expDate);
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

    // Vector embedding (non-blocking, best-effort)
    if (this.vecAvailable && config.FF_VECTOR_SEARCH) {
      try {
        const { chunkText, generateEmbeddings } = await import("../services/embedding.ts");
        const chunks = chunkText(input.content);
        const embeddings = await generateEmbeddings(chunks);

        for (let i = 0; i < chunks.length; i++) {
          if (embeddings[i]) {
            const chunkId = this.db.prepare(
              "INSERT INTO memory_chunks (memory_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
            ).run(id, i, chunks[i], Buffer.from(embeddings[i]!.buffer)).lastInsertRowid;

            this.db.prepare(
              "INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)"
            ).run(chunkId, Buffer.from(embeddings[i]!.buffer));
          }
        }
        console.log(`[SmartMemory] Embedded #${id}: ${chunks.length} chunks`);
      } catch (err) {
        console.warn("[SmartMemory] Embedding failed, FTS5 only:", err);
      }
    }

    return id;
  }

  /**
   * Search memories using hybrid FTS5 + vector search with RRF fusion
   * Falls back to FTS5-only + Haiku ranking when vector search is unavailable
   */
  async search(query: string, options?: {
    type?: MemoryType;
    limit?: number;
    minScore?: number;
  }): Promise<MemorySearchResult[]> {
    const limit = options?.limit ?? 5;
    const minScore = options?.minScore ?? 0.5;
    const useVector = this.vecAvailable && config.FF_VECTOR_SEARCH;

    // Step 1: Run FTS5 + vector search (parallel when possible)
    const ftsCandidates = this.fts5Search(query, options?.type, 20);
    const vecResults = useVector
      ? await this.vectorSearch(query, options?.type, 20)
      : [];

    // If neither search found anything, return empty
    if (ftsCandidates.length === 0 && vecResults.length === 0) {
      return [];
    }

    // Step 2: If vector is active, do hybrid fusion
    if (useVector && (ftsCandidates.length > 0 || vecResults.length > 0)) {
      // Build fusion map: memoryId -> { ftsScore, vectorScore }
      const fusionMap = new Map<number, { ftsScore: number; vectorScore: number }>();

      // Normalize FTS scores: 1 / (1 + rank) where rank is 0-indexed position
      for (let rank = 0; rank < ftsCandidates.length; rank++) {
        const mem = ftsCandidates[rank];
        fusionMap.set(mem.id, {
          ftsScore: 1 / (1 + rank),
          vectorScore: 0,
        });
      }

      // Add vector scores (already 0-1 similarity from vectorSearch)
      for (const vr of vecResults) {
        const existing = fusionMap.get(vr.memoryId);
        if (existing) {
          existing.vectorScore = vr.score;
        } else {
          fusionMap.set(vr.memoryId, {
            ftsScore: 0,
            vectorScore: vr.score,
          });
        }
      }

      // Calculate fused scores
      const fusedEntries: Array<{
        memoryId: number;
        ftsScore: number;
        vectorScore: number;
        fusedScore: number;
      }> = [];

      for (const [memoryId, scores] of fusionMap) {
        const fusedScore =
          config.VECTOR_WEIGHT * scores.vectorScore +
          config.FTS_WEIGHT * scores.ftsScore;
        fusedEntries.push({
          memoryId,
          ftsScore: scores.ftsScore,
          vectorScore: scores.vectorScore,
          fusedScore,
        });
      }

      // Sort by fusedScore DESC
      fusedEntries.sort((a, b) => b.fusedScore - a.fusedScore);

      // Step 3: Fetch full MemoryEntry for top results
      const results: MemorySearchResult[] = [];
      const topEntries = fusedEntries.slice(0, limit);

      for (const entry of topEntries) {
        // Apply importance/access_count bonus
        let bonusScore = entry.fusedScore;

        // Try to find in FTS candidates first (already loaded)
        let memEntry = ftsCandidates.find((c) => c.id === entry.memoryId);

        // If only found via vector, fetch from DB
        if (!memEntry) {
          memEntry = this.getById(entry.memoryId) ?? undefined;
        }

        if (!memEntry) continue;

        // Importance bonus: up to +0.1 for high-importance memories
        bonusScore += memEntry.importance * 0.1;
        // Access count bonus: up to +0.05 for frequently accessed
        bonusScore += Math.min(memEntry.accessCount / 100, 0.05);

        if (bonusScore < minScore) continue;

        results.push({
          ...memEntry,
          similarity: bonusScore,
          ftsScore: entry.ftsScore,
          vectorScore: entry.vectorScore,
          fusedScore: entry.fusedScore,
        });

        // Update access count
        this.db.run(
          "UPDATE memories SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?",
          [memEntry.id]
        );
      }

      console.log(`[SmartMemory] Hybrid search: ${ftsCandidates.length} FTS + ${vecResults.length} vec → ${results.length} results`);
      return results;
    }

    // Fallback: FTS5-only path (vector disabled or failed)
    // If Haiku is available, rank semantically
    if (isHaikuAvailable()) {
      try {
        const ranked = await rankMemories(
          query,
          ftsCandidates.map((c) => ({
            id: c.id,
            content: c.content,
            summary: c.summary,
            importance: c.importance,
            createdAt: c.createdAt,
            accessCount: c.accessCount,
          })),
          limit
        );

        const results: MemorySearchResult[] = [];

        for (const r of ranked) {
          if (r.score < minScore) continue;

          const mem = ftsCandidates.find((c) => c.id === r.id);
          if (mem) {
            results.push({ ...mem, similarity: r.score });

            // Update access count
            this.db.run(
              "UPDATE memories SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?",
              [mem.id]
            );
          }
        }

        return results;
      } catch (error) {
        console.warn("[SmartMemory] Haiku ranking failed, using FTS5 results:", error);
      }
    }

    // Final fallback: return FTS5 results with estimated scores
    return ftsCandidates.slice(0, limit).map((c) => ({
      ...c,
      similarity: 0.5,
    }));
  }

  /**
   * FTS5-based full-text search
   */
  private fts5Search(query: string, type?: MemoryType, limit: number = 10): MemoryEntry[] {
    // Sanitize FTS5 query: strip special chars/operators, escape quotes, wrap in double quotes
    const fts5SpecialOps = /\b(AND|OR|NOT|NEAR)\b/gi;
    const fts5SpecialChars = /[*"():^{}[\]~<>|\\+\-!]/g;

    const keywords = query
      .toLowerCase()
      .replace(fts5SpecialOps, " ")      // Remove FTS5 boolean operators
      .replace(fts5SpecialChars, " ")     // Remove FTS5 special characters
      .split(/\s+/)
      .filter((k) => k.length > 2)
      .map((k) => `"${k.replace(/"/g, "")}"*`) // Escape any residual quotes, prefix search
      .join(" OR ");

    if (!keywords) {
      console.log(`[SmartMemory] No valid keywords for FTS5 search`);
      return [];
    }

    console.log(`[SmartMemory] FTS5 search: ${keywords}`);

    let whereClause = "(expires_at IS NULL OR expires_at > datetime('now')) AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.softDeleted') IS NOT 1)";
    const params: (string | number)[] = [keywords];

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
           WHERE memories_fts MATCH ? AND ${whereClause}
           ORDER BY bm25(memories_fts)
           LIMIT ?`
        )
        .all(...params);

      console.log(`[SmartMemory] FTS5 candidates found: ${rows.length}`);

      return rows.map((row) => ({
        id: row.id,
        type: row.type as MemoryType,
        content: row.content,
        summary: row.summary ?? undefined,
        tags: row.tags ?? undefined,
        importance: row.importance,
        accessCount: row.access_count,
        lastAccessedAt: row.last_accessed_at ?? undefined,
        source: row.source ?? undefined,
        sourceRef: row.source_ref ?? undefined,
        metadata: safeParseJson(row.metadata),
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

    let whereClause = "(expires_at IS NULL OR expires_at > datetime('now')) AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)";
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
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /**
   * Vector similarity search using sqlite-vec
   */
  private async vectorSearch(
    query: string,
    type?: MemoryType,
    limit: number = 20,
  ): Promise<Array<{ memoryId: number; score: number }>> {
    if (!this.vecAvailable) return [];

    try {
      const { generateEmbedding } = await import("../services/embedding.ts");
      const queryEmbedding = await generateEmbedding(query);
      if (!queryEmbedding) return [];

      const whereClause = this.buildWhereClause(type);

      const rows = this.db
        .prepare(
          `SELECT mc.memory_id, MIN(vec_distance_cosine(mv.embedding, ?)) as distance
           FROM memory_vec mv
           JOIN memory_chunks mc ON mc.id = mv.chunk_id
           JOIN memories m ON m.id = mc.memory_id
           WHERE ${whereClause}
           GROUP BY mc.memory_id
           ORDER BY distance ASC
           LIMIT ?`
        )
        .all(Buffer.from(queryEmbedding.buffer), limit);

      return (rows as any[]).map((r) => ({
        memoryId: r.memory_id,
        score: 1 - r.distance, // Convert distance to similarity
      }));
    } catch (err) {
      console.warn("[SmartMemory] Vector search failed:", err);
      return [];
    }
  }

  /**
   * Build WHERE clause for soft-delete + expiry + optional type filter
   */
  private buildWhereClause(type?: MemoryType): string {
    const conditions = [
      "(m.expires_at IS NULL OR m.expires_at > datetime('now'))",
      "(NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.softDeleted') IS NOT 1)",
    ];
    if (type) conditions.push(`m.type = '${type}'`);
    return conditions.join(" AND ");
  }

  /**
   * Backfill embeddings for memories that don't have chunks yet
   */
  async backfillEmbeddings(): Promise<number> {
    if (!this.vecAvailable || !config.FF_VECTOR_SEARCH) return 0;

    const unindexed = this.db
      .prepare(
        `SELECT m.id, m.content FROM memories m
         LEFT JOIN memory_chunks mc ON mc.memory_id = m.id
         WHERE mc.id IS NULL
         AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.softDeleted') IS NOT 1)`
      )
      .all() as Array<{ id: number; content: string }>;

    let count = 0;
    const { chunkText, generateEmbeddings } = await import("../services/embedding.ts");

    for (let i = 0; i < unindexed.length; i += 10) {
      const batch = unindexed.slice(i, i + 10);
      for (const mem of batch) {
        try {
          const chunks = chunkText(mem.content);
          const embeddings = await generateEmbeddings(chunks);
          for (let j = 0; j < chunks.length; j++) {
            if (embeddings[j]) {
              const chunkId = this.db
                .prepare(
                  "INSERT INTO memory_chunks (memory_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?)"
                )
                .run(mem.id, j, chunks[j]!, Buffer.from(embeddings[j]!.buffer)).lastInsertRowid;
              this.db
                .prepare(
                  "INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)"
                )
                .run(chunkId, Buffer.from(embeddings[j]!.buffer));
            }
          }
          count++;
        } catch (err) {
          console.warn(`[SmartMemory] Backfill failed for memory ${mem.id}:`, err);
        }
      }
    }

    console.log(`[SmartMemory] Backfilled embeddings for ${count}/${unindexed.length} memories`);
    return count;
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
   * Get top memories by importance score (for context injection)
   */
  getByImportance(limit: number = 3, minImportance: number = 0.6): MemoryEntry[] {
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
      }, [number, number]>(
        `SELECT * FROM memories
         WHERE importance >= ?
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)
         ORDER BY importance DESC, access_count DESC
         LIMIT ?`
      )
      .all(minImportance, limit);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
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
      }, [number]>(
        `SELECT * FROM memories
         WHERE (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
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
    const activeFilter = "(NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)";

    const total =
      this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM memories WHERE ${activeFilter}`).get()?.count ?? 0;

    const episodic =
      this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM memories WHERE type = 'episodic' AND ${activeFilter}`).get()?.count ?? 0;

    const semantic =
      this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM memories WHERE type = 'semantic' AND ${activeFilter}`).get()?.count ?? 0;

    const procedural =
      this.db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM memories WHERE type = 'procedural' AND ${activeFilter}`).get()?.count ?? 0;

    const avgImportance =
      this.db.query<{ avg: number }, []>(`SELECT AVG(importance) as avg FROM memories WHERE ${activeFilter}`).get()?.avg ?? 0;

    const oldest =
      this.db.query<{ created_at: string }, []>(`SELECT created_at FROM memories WHERE ${activeFilter} ORDER BY created_at ASC LIMIT 1`).get()?.created_at ?? null;

    const newest =
      this.db.query<{ created_at: string }, []>(`SELECT created_at FROM memories WHERE ${activeFilter} ORDER BY created_at DESC LIMIT 1`).get()?.created_at ?? null;

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
      const merged = { ...safeParseJson(row.metadata), ...metadata };
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
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)
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

  // ========== CONSOLIDATION METHODS ==========

  /**
   * Get a single memory by ID
   */
  getById(id: number): MemoryEntry | null {
    const row = this.db
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
      }, [number]>("SELECT * FROM memories WHERE id = ?")
      .get(id);

    if (!row) return null;

    return {
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  /**
   * Get episodic memories eligible for promotion to semantic
   */
  getPromotionCandidates(minAccess: number, minImportance: number, daysBack: number): MemoryEntry[] {
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
      }, [number, number, string]>(
        `SELECT * FROM memories
         WHERE type = 'episodic'
         AND access_count >= ?
         AND importance >= ?
         AND created_at >= datetime('now', ?)
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)
         ORDER BY access_count DESC, importance DESC
         LIMIT 50`
      )
      .all(minAccess, minImportance, `-${daysBack} days`);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /**
   * Get recent memories grouped by tags for duplicate detection
   */
  getRecentByTags(daysBack: number, limit: number): MemoryEntry[] {
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
      }, [string, number]>(
        `SELECT * FROM memories
         WHERE created_at >= datetime('now', ?)
         AND tags IS NOT NULL AND tags != ''
         AND type != 'procedural'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(`-${daysBack} days`, limit);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /**
   * Get memories with same tags but different content (conflict candidates)
   */
  getConflictCandidates(daysBack: number): MemoryEntry[] {
    // Get semantic memories with overlapping tags from the last N days
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
      }, [string]>(
        `SELECT * FROM memories
         WHERE type = 'semantic'
         AND tags IS NOT NULL AND tags != ''
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)
         AND created_at >= datetime('now', ?)
         ORDER BY tags, created_at DESC
         LIMIT 100`
      )
      .all(`-${daysBack} days`);

    return rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryType,
      content: row.content,
      summary: row.summary ?? undefined,
      tags: row.tags ?? undefined,
      importance: row.importance,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at ?? undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
      metadata: safeParseJson(row.metadata),
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  /**
   * Promote an episodic memory to semantic (permanent)
   */
  promoteToSemantic(id: number): boolean {
    const result = this.db.run(
      `UPDATE memories
       SET type = 'semantic', expires_at = NULL,
           metadata = json_set(metadata, '$.promotedAt', datetime('now'), '$.promotedFrom', 'episodic')
       WHERE id = ? AND type = 'episodic'`,
      [id]
    );
    return result.changes > 0;
  }

  /**
   * Soft-delete a memory (reversible — sets metadata.softDeleted)
   */
  softDelete(id: number, reason: string, replacedBy?: number): boolean {
    const sql = replacedBy !== undefined
      ? `UPDATE memories SET metadata = json_set(metadata,
           '$.softDeleted', 1,
           '$.softDeletedAt', datetime('now'),
           '$.softDeleteReason', ?,
           '$.replacedBy', ?
         ) WHERE id = ?`
      : `UPDATE memories SET metadata = json_set(metadata,
           '$.softDeleted', 1,
           '$.softDeletedAt', datetime('now'),
           '$.softDeleteReason', ?
         ) WHERE id = ?`;

    const params = replacedBy !== undefined
      ? [reason, replacedBy, id]
      : [reason, id];

    const result = this.db.run(sql, params);
    return result.changes > 0;
  }

  /**
   * Merge multiple source memories into a target (soft-delete sources, update target metadata)
   */
  mergeMemories(sourceIds: number[], targetId: number): boolean {
    // Validate target exists and is not soft-deleted
    const target = this.getById(targetId);
    if (!target || target.metadata?.softDeleted) {
      console.warn(`[SmartMemory] Merge target #${targetId} invalid or soft-deleted, skipping`);
      return false;
    }

    const tx = this.db.transaction(() => {
      for (const sourceId of sourceIds) {
        this.softDelete(sourceId, "merged", targetId);
      }
      // Update target metadata with merge info
      this.db.run(
        `UPDATE memories SET metadata = json_set(metadata, '$.mergedFrom', ?, '$.mergedAt', datetime('now'))
         WHERE id = ?`,
        [JSON.stringify(sourceIds), targetId]
      );
    });
    tx();
    return true;
  }

  /**
   * Update importance score for a memory
   */
  updateImportance(id: number, newImportance: number): boolean {
    const clamped = Math.max(0.1, Math.min(1.0, newImportance));
    const result = this.db.run(
      "UPDATE memories SET importance = ? WHERE id = ?",
      [clamped, id]
    );
    return result.changes > 0;
  }

  /**
   * Get all memories needing importance rebalance
   */
  getRebalanceCandidates(): { upCandidates: { id: number; importance: number }[]; downCandidates: { id: number; importance: number }[] } {
    const upRows = this.db
      .query<{ id: number; importance: number }, []>(
        `SELECT id, importance FROM memories
         WHERE access_count > 5 AND importance < 1.0
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)`
      )
      .all();

    const downRows = this.db
      .query<{ id: number; importance: number }, []>(
        `SELECT id, importance FROM memories
         WHERE access_count = 0
         AND created_at < datetime('now', '-30 days')
         AND importance > 0.1
         AND type != 'procedural'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (NOT json_valid(metadata) OR json_extract(metadata, '$.softDeleted') IS NOT 1)`
      )
      .all();

    return { upCandidates: upRows, downCandidates: downRows };
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

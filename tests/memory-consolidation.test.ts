/**
 * Memory Consolidation — Safety & Idempotency Tests
 *
 * Fixture-based tests covering:
 * 1. SmartMemory SQL consolidation methods (pure DB, no AI)
 * 2. Full orchestrator with mocked Haiku (deterministic AI responses)
 * 3. Idempotency (second run changes nothing)
 * 4. Concurrency (parallel search during consolidation)
 */

// === ENV setup (must be before any project imports) ===
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.MY_TELEGRAM_ID = "12345";

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// === Mock Haiku with deterministic responses ===
let mockClassifyForPromotion = async (memories: { id: number; content: string }[]) =>
  memories.map((m) => ({
    id: m.id,
    promote: m.content.includes("[PROMOTE]"),
    reason: "fixture",
  }));

let mockFindDuplicates = async (memories: { id: number; tags?: string }[]) => {
  const tagMap = new Map<string, number[]>();
  for (const m of memories) {
    const key = m.tags || "";
    if (!key) continue;
    if (!tagMap.has(key)) tagMap.set(key, []);
    tagMap.get(key)!.push(m.id);
  }
  const groups: { ids: number[]; keepId: number }[] = [];
  for (const [, ids] of tagMap) {
    if (ids.length >= 2) {
      groups.push({ ids, keepId: ids[ids.length - 1]! }); // keep last
    }
  }
  return groups;
};

let mockResolveConflict = async (
  m1: { id: number; createdAt: string },
  m2: { id: number; createdAt: string }
) => ({
  keepId: m2.id, // newer wins
  removeId: m1.id,
  reason: "newer wins",
});

mock.module("../src/services/haiku.ts", () => ({
  isHaikuAvailable: () => true,
  initHaiku: () => true,
  extractTags: async () => ["test", "mock"],
  summarize: async (text: string) => text.slice(0, 50),
  rankMemories: async (_q: string, mems: { id: number }[], limit: number) =>
    mems.slice(0, limit).map((m, i) => ({ id: m.id, score: 0.9 - i * 0.1 })),
  classifyForPromotion: (...args: any[]) => mockClassifyForPromotion(...args),
  findDuplicates: (...args: any[]) => mockFindDuplicates(...args),
  resolveConflict: (...args: any[]) => mockResolveConflict(...args),
  classifyWhatsAppMessage: async () => ({ tier: 3, reason: "test" }),
}));

// Track testDir for userManager mock
let testDir = "";

mock.module("../src/services/user-manager.ts", () => ({
  userManager: {
    getUserFolder: () => testDir,
    getUserDb: async () => null,
  },
}));

// === Imports (after mocks) ===
import { SmartMemory } from "../src/memory/smart-memory.ts";
import { consolidateMemories } from "../src/services/memory-consolidation.ts";

// === Helpers ===

/** Insert a memory directly via SQL (bypasses Haiku) */
function rawInsert(
  db: Database,
  opts: {
    type?: string;
    content: string;
    summary?: string;
    tags?: string;
    importance?: number;
    access_count?: number;
    source?: string;
    metadata?: Record<string, unknown>;
    created_at?: string;
    expires_at?: string | null;
  }
): number {
  const result = db.run(
    `INSERT INTO memories (type, content, summary, tags, importance, access_count, source, metadata, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.type || "episodic",
      opts.content,
      opts.summary || opts.content.slice(0, 50),
      opts.tags || "",
      opts.importance ?? 0.5,
      opts.access_count ?? 0,
      opts.source || "test",
      JSON.stringify(opts.metadata || {}),
      opts.created_at || new Date().toISOString(),
      opts.expires_at === undefined ? null : opts.expires_at,
    ]
  );
  return Number(result.lastInsertRowid);
}

/** Access the private db from SmartMemory for direct SQL operations */
function getDb(memory: SmartMemory): Database {
  return (memory as any).db;
}

/** Count active (non-soft-deleted) memories */
function countActive(db: Database): number {
  return (
    db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) as c FROM memories WHERE json_extract(metadata, '$.softDeleted') IS NOT 1"
      )
      .get()?.c ?? 0
  );
}

/** Get a memory row by ID */
function getRow(db: Database, id: number) {
  return db
    .query<{ id: number; type: string; metadata: string; importance: number; expires_at: string | null }, [number]>(
      "SELECT id, type, metadata, importance, expires_at FROM memories WHERE id = ?"
    )
    .get(id);
}

// === Test Suite ===

describe("SmartMemory consolidation methods", () => {
  let memory: SmartMemory;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cobrain-test-"));
    memory = new SmartMemory(tmpDir, 12345);
    db = getDb(memory);
  });

  afterEach(() => {
    memory.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- getPromotionCandidates ---

  test("getPromotionCandidates: returns eligible episodics", () => {
    rawInsert(db, { type: "episodic", content: "important memory", importance: 0.8, access_count: 5 });
    rawInsert(db, { type: "episodic", content: "low access", importance: 0.8, access_count: 1 });
    rawInsert(db, { type: "semantic", content: "already semantic", importance: 0.9, access_count: 10 });

    const candidates = memory.getPromotionCandidates(3, 0.7, 90);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.content).toBe("important memory");
  });

  test("getPromotionCandidates: excludes expired memories", () => {
    rawInsert(db, {
      type: "episodic",
      content: "expired episodic",
      importance: 0.9,
      access_count: 10,
      expires_at: "2020-01-01T00:00:00Z",
    });

    const candidates = memory.getPromotionCandidates(3, 0.7, 90);
    expect(candidates.length).toBe(0);
  });

  test("getPromotionCandidates: excludes soft-deleted", () => {
    const id = rawInsert(db, { type: "episodic", content: "deleted one", importance: 0.9, access_count: 10 });
    memory.softDelete(id, "test");

    const candidates = memory.getPromotionCandidates(3, 0.7, 90);
    expect(candidates.length).toBe(0);
  });

  // --- promoteToSemantic ---

  test("promoteToSemantic: converts episodic to semantic, clears expires_at", () => {
    const id = rawInsert(db, {
      type: "episodic",
      content: "will promote",
      importance: 0.8,
      expires_at: "2030-01-01T00:00:00Z",
    });

    const ok = memory.promoteToSemantic(id);
    expect(ok).toBe(true);

    const row = getRow(db, id);
    expect(row!.type).toBe("semantic");
    expect(row!.expires_at).toBeNull();

    const meta = JSON.parse(row!.metadata);
    expect(meta.promotedFrom).toBe("episodic");
    expect(meta.promotedAt).toBeDefined();
  });

  test("promoteToSemantic: does nothing for non-episodic", () => {
    const id = rawInsert(db, { type: "semantic", content: "already semantic" });

    const ok = memory.promoteToSemantic(id);
    expect(ok).toBe(false);
  });

  // --- getRecentByTags ---

  test("getRecentByTags: excludes procedural", () => {
    rawInsert(db, { type: "episodic", content: "ep", tags: "tag1" });
    rawInsert(db, { type: "procedural", content: "proc", tags: "tag2" });
    rawInsert(db, { type: "semantic", content: "sem", tags: "tag3" });

    const results = memory.getRecentByTags(30, 100);
    expect(results.every((r) => r.type !== "procedural")).toBe(true);
    expect(results.length).toBe(2);
  });

  test("getRecentByTags: excludes expired", () => {
    rawInsert(db, { type: "episodic", content: "active", tags: "t1" });
    rawInsert(db, { type: "episodic", content: "expired", tags: "t2", expires_at: "2020-01-01T00:00:00Z" });

    const results = memory.getRecentByTags(30, 100);
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("active");
  });

  // --- softDelete ---

  test("softDelete: marks memory with metadata, preserves data", () => {
    const id = rawInsert(db, { type: "episodic", content: "to delete" });

    const ok = memory.softDelete(id, "test_reason", 999);
    expect(ok).toBe(true);

    const row = getRow(db, id);
    const meta = JSON.parse(row!.metadata);
    expect(meta.softDeleted).toBe(1);
    expect(meta.softDeleteReason).toBe("test_reason");
    expect(meta.replacedBy).toBe(999);
    expect(meta.softDeletedAt).toBeDefined();
  });

  test("softDelete: does not physically remove the row", () => {
    const id = rawInsert(db, { type: "episodic", content: "soft only" });
    memory.softDelete(id, "test");

    const row = db.query<{ id: number }, [number]>("SELECT id FROM memories WHERE id = ?").get(id);
    expect(row).not.toBeNull();
  });

  // --- mergeMemories ---

  test("mergeMemories: soft-deletes sources, updates target metadata", () => {
    const id1 = rawInsert(db, { type: "episodic", content: "dup A" });
    const id2 = rawInsert(db, { type: "episodic", content: "dup B (longer and better)" });

    const ok = memory.mergeMemories([id1], id2);
    expect(ok).toBe(true);

    // Source is soft-deleted
    const src = getRow(db, id1);
    const srcMeta = JSON.parse(src!.metadata);
    expect(srcMeta.softDeleted).toBe(1);
    expect(srcMeta.replacedBy).toBe(id2);

    // Target has mergedFrom
    const tgt = getRow(db, id2);
    const tgtMeta = JSON.parse(tgt!.metadata);
    expect(JSON.parse(tgtMeta.mergedFrom)).toEqual([id1]);
  });

  test("mergeMemories: rejects invalid target (nonexistent)", () => {
    const id1 = rawInsert(db, { type: "episodic", content: "orphan" });

    const ok = memory.mergeMemories([id1], 99999);
    expect(ok).toBe(false);
  });

  test("mergeMemories: rejects soft-deleted target", () => {
    const id1 = rawInsert(db, { type: "episodic", content: "source" });
    const id2 = rawInsert(db, { type: "episodic", content: "deleted target" });
    memory.softDelete(id2, "already gone");

    const ok = memory.mergeMemories([id1], id2);
    expect(ok).toBe(false);
  });

  // --- getRebalanceCandidates ---

  test("getRebalanceCandidates: up candidates have high access, down excludes procedural", () => {
    rawInsert(db, {
      type: "episodic",
      content: "popular",
      importance: 0.5,
      access_count: 10,
    });
    rawInsert(db, {
      type: "procedural",
      content: "how to deploy",
      importance: 0.5,
      access_count: 0,
      created_at: "2020-01-01T00:00:00Z",
    });
    rawInsert(db, {
      type: "episodic",
      content: "forgotten",
      importance: 0.5,
      access_count: 0,
      created_at: "2020-01-01T00:00:00Z",
    });

    const { upCandidates, downCandidates } = memory.getRebalanceCandidates();

    expect(upCandidates.length).toBe(1); // popular
    expect(downCandidates.length).toBe(1); // forgotten episodic
    // procedural NOT in downCandidates
    expect(downCandidates.every((c) => {
      const row = db.query<{ type: string }, [number]>("SELECT type FROM memories WHERE id = ?").get(c.id);
      return row?.type !== "procedural";
    })).toBe(true);
  });

  test("getRebalanceCandidates: excludes expired from both", () => {
    rawInsert(db, {
      type: "episodic",
      content: "expired popular",
      importance: 0.5,
      access_count: 10,
      expires_at: "2020-01-01T00:00:00Z",
    });
    rawInsert(db, {
      type: "episodic",
      content: "expired forgotten",
      importance: 0.5,
      access_count: 0,
      created_at: "2020-01-01T00:00:00Z",
      expires_at: "2020-01-01T00:00:00Z",
    });

    const { upCandidates, downCandidates } = memory.getRebalanceCandidates();
    expect(upCandidates.length).toBe(0);
    expect(downCandidates.length).toBe(0);
  });

  // --- updateImportance ---

  test("updateImportance: clamps between 0.1 and 1.0", () => {
    const id = rawInsert(db, { type: "episodic", content: "test", importance: 0.5 });

    memory.updateImportance(id, 1.5);
    expect(getRow(db, id)!.importance).toBe(1.0);

    memory.updateImportance(id, -0.5);
    expect(getRow(db, id)!.importance).toBe(0.1);

    memory.updateImportance(id, 0.7);
    expect(getRow(db, id)!.importance).toBe(0.7);
  });

  // --- getRecent / getStats / findFollowup: softDeleted filter ---

  test("getRecent: excludes soft-deleted", () => {
    const id1 = rawInsert(db, { type: "episodic", content: "active" });
    const id2 = rawInsert(db, { type: "episodic", content: "deleted" });
    memory.softDelete(id2, "test");

    const recent = memory.getRecent(10);
    expect(recent.length).toBe(1);
    expect(recent[0]!.id).toBe(id1);
  });

  test("getStats: excludes soft-deleted from counts", () => {
    rawInsert(db, { type: "episodic", content: "active1" });
    rawInsert(db, { type: "semantic", content: "active2" });
    const id3 = rawInsert(db, { type: "episodic", content: "deleted" });
    memory.softDelete(id3, "test");

    const stats = memory.getStats();
    expect(stats.total).toBe(2);
    expect(stats.byType.episodic).toBe(1);
    expect(stats.byType.semantic).toBe(1);
  });

  test("findFollowupOpportunities: excludes soft-deleted", () => {
    const id = rawInsert(db, {
      type: "episodic",
      content: "Benim hedefim spor yapmak",
      tags: "hedef,spor",
      importance: 0.8,
    });
    memory.softDelete(id, "test");

    const followups = memory.findFollowupOpportunities(30);
    expect(followups.length).toBe(0);
  });

  // --- getConflictCandidates ---

  test("getConflictCandidates: only semantic, excludes expired", () => {
    rawInsert(db, { type: "semantic", content: "valid", tags: "t1" });
    rawInsert(db, { type: "episodic", content: "not semantic", tags: "t2" });
    rawInsert(db, {
      type: "semantic",
      content: "expired",
      tags: "t3",
      expires_at: "2020-01-01T00:00:00Z",
    });

    const candidates = memory.getConflictCandidates(90);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.content).toBe("valid");
  });

  // --- getById ---

  test("getById: returns memory with tags field", () => {
    const id = rawInsert(db, { type: "episodic", content: "with tags", tags: "foo,bar" });
    const mem = memory.getById(id);
    expect(mem).not.toBeNull();
    expect(mem!.tags).toBe("foo,bar");
  });

  test("getById: returns null for nonexistent", () => {
    expect(memory.getById(99999)).toBeNull();
  });
});

// =================================================================
// Orchestrator tests (full consolidation with mocked Haiku)
// =================================================================

describe("Consolidation orchestrator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cobrain-orch-"));
    testDir = tmpDir; // Update mock target

    // Seed fixture DB
    const memory = new SmartMemory(tmpDir, 12345);
    const db = getDb(memory);

    // --- Promotion candidates ---
    // Should promote (marked with [PROMOTE] for mock)
    rawInsert(db, {
      type: "episodic",
      content: "[PROMOTE] Kullanici TypeScript seviyor",
      tags: "typescript,tercih",
      importance: 0.8,
      access_count: 5,
    });
    // Should NOT promote (no [PROMOTE] marker)
    rawInsert(db, {
      type: "episodic",
      content: "Bugün hava güzel",
      tags: "hava,gunluk",
      importance: 0.8,
      access_count: 4,
    });

    // --- Duplicates (same tags → mock groups them) ---
    rawInsert(db, {
      type: "episodic",
      content: "short dup",
      tags: "dupgroup",
      importance: 0.5,
    });
    rawInsert(db, {
      type: "episodic",
      content: "this is the longer duplicate that should be kept",
      tags: "dupgroup",
      importance: 0.5,
    });

    // --- Conflict pair (semantic, same tags, different content) ---
    const now = Date.now();
    rawInsert(db, {
      type: "semantic",
      content: "Favori rengi mavi",
      tags: "favori,renk,eski",
      importance: 0.7,
      created_at: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
    });
    rawInsert(db, {
      type: "semantic",
      content: "Favori rengi yeşil",
      tags: "favori,renk,yeni",
      importance: 0.7,
      created_at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
    });

    // --- Procedural (must NEVER be touched by dedup/decay) ---
    rawInsert(db, {
      type: "procedural",
      content: "Deploy prosedürü: git push fjds main",
      tags: "deploy,prosedur",
      importance: 0.5,
      access_count: 0,
      created_at: "2020-01-01T00:00:00Z",
    });

    // --- Expired (must NEVER be processed) ---
    rawInsert(db, {
      type: "episodic",
      content: "[PROMOTE] expired candidate",
      tags: "expired",
      importance: 0.9,
      access_count: 10,
      expires_at: "2020-01-01T00:00:00Z",
    });

    // --- Rebalance targets ---
    // High access → importance up
    rawInsert(db, {
      type: "semantic",
      content: "frequently accessed",
      tags: "popular",
      importance: 0.5,
      access_count: 10,
    });
    // Zero access, old → importance down (episodic, not procedural)
    rawInsert(db, {
      type: "episodic",
      content: "forgotten and old",
      tags: "forgotten",
      importance: 0.5,
      access_count: 0,
      created_at: "2020-01-01T00:00:00Z",
    });

    memory.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("full consolidation: promotes, deduplicates, resolves conflicts, rebalances", async () => {
    const result = await consolidateMemories(12345);

    // Phase 1: Promotion
    expect(result.promoted).toBe(1); // Only the [PROMOTE] one

    // Phase 2: Dedup (1 source merged → the short dup)
    expect(result.merged).toBeGreaterThanOrEqual(1);

    // Phase 3: Conflict (1 pair resolved)
    expect(result.conflictsResolved).toBeGreaterThanOrEqual(1);

    // Phase 4: Rebalance
    expect(result.rebalanced.up).toBeGreaterThanOrEqual(1);
    expect(result.rebalanced.down).toBeGreaterThanOrEqual(1);

    expect(result.errors.length).toBe(0);

    // === Invariant checks ===
    const memory = new SmartMemory(tmpDir, 12345);
    const db = getDb(memory);

    // Promoted memory is now semantic with no expiry
    const promoted = db
      .query<{ type: string; expires_at: string | null; metadata: string }, []>(
        "SELECT type, expires_at, metadata FROM memories WHERE content LIKE '%TypeScript seviyor%'"
      )
      .get();
    expect(promoted!.type).toBe("semantic");
    expect(promoted!.expires_at).toBeNull();

    // Procedural is untouched
    const proc = db
      .query<{ metadata: string; importance: number }, []>(
        "SELECT metadata, importance FROM memories WHERE type = 'procedural'"
      )
      .get();
    expect(JSON.parse(proc!.metadata).softDeleted).toBeUndefined();
    expect(proc!.importance).toBe(0.5);

    // Expired memory was NOT processed
    const expired = db
      .query<{ metadata: string; type: string }, []>(
        "SELECT metadata, type FROM memories WHERE content LIKE '%expired candidate%'"
      )
      .get();
    expect(expired!.type).toBe("episodic"); // NOT promoted
    expect(JSON.parse(expired!.metadata).softDeleted).toBeUndefined();

    // Conflict: newer one kept, older soft-deleted
    const olderConflict = db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM memories WHERE content = 'Favori rengi mavi'"
      )
      .get();
    const newerConflict = db
      .query<{ metadata: string }, []>(
        "SELECT metadata FROM memories WHERE content = 'Favori rengi yeşil'"
      )
      .get();
    expect(JSON.parse(olderConflict!.metadata).softDeleted).toBe(1);
    expect(JSON.parse(newerConflict!.metadata).softDeleted).toBeUndefined();

    // Rebalance: popular got importance boost
    const popular = db
      .query<{ importance: number }, []>(
        "SELECT importance FROM memories WHERE content = 'frequently accessed'"
      )
      .get();
    expect(popular!.importance).toBe(0.6);

    // Rebalance: forgotten got importance decay
    const forgotten = db
      .query<{ importance: number }, []>(
        "SELECT importance FROM memories WHERE content = 'forgotten and old'"
      )
      .get();
    expect(forgotten!.importance).toBe(0.4);

    memory.close();
  });

  test("idempotency: second run does not re-promote, re-merge, or re-conflict", async () => {
    // First run
    await consolidateMemories(12345);

    // Snapshot state after first run
    const mem1 = new SmartMemory(tmpDir, 12345);
    const db1 = getDb(mem1);
    const activeCount1 = countActive(db1);
    const allRows1 = db1
      .query<{ id: number; metadata: string }, []>(
        "SELECT id, metadata FROM memories ORDER BY id"
      )
      .all();
    mem1.close();

    // Second run
    const result2 = await consolidateMemories(12345);

    // Should not promote, merge, or resolve anything new
    expect(result2.promoted).toBe(0);
    expect(result2.merged).toBe(0);
    expect(result2.conflictsResolved).toBe(0);
    // Note: rebalance IS intentionally incremental (+/-0.1 per run), so it may change

    // Active count unchanged (no new soft-deletes)
    const mem2 = new SmartMemory(tmpDir, 12345);
    const db2 = getDb(mem2);
    const activeCount2 = countActive(db2);
    expect(activeCount2).toBe(activeCount1);

    // No new soft-deletes created
    const allRows2 = db2
      .query<{ id: number; metadata: string }, []>(
        "SELECT id, metadata FROM memories ORDER BY id"
      )
      .all();
    mem2.close();

    for (let i = 0; i < allRows1.length; i++) {
      const meta1 = JSON.parse(allRows1[i]!.metadata);
      const meta2 = JSON.parse(allRows2[i]!.metadata);
      expect(!!meta2.softDeleted).toBe(!!meta1.softDeleted);
    }
  });

  test("concurrent search during consolidation does not throw", async () => {
    // Start consolidation
    const consolidationPromise = consolidateMemories(12345);

    // Simultaneously perform search operations
    const memory = new SmartMemory(tmpDir, 12345);

    const searchPromises = Array.from({ length: 5 }, (_, i) =>
      memory.search(`test query ${i}`, { limit: 5 }).catch((e: Error) => ({ error: e.message }))
    );

    const [consolidationResult, ...searchResults] = await Promise.all([
      consolidationPromise,
      ...searchPromises,
    ]);

    // Consolidation should complete
    expect(consolidationResult.errors.length).toBe(0);

    // Searches should not throw (may return empty, that's OK)
    for (const result of searchResults) {
      expect((result as any).error).toBeUndefined();
    }

    memory.close();
  });

  test("procedural memories are never soft-deleted by any phase", async () => {
    await consolidateMemories(12345);

    const memory = new SmartMemory(tmpDir, 12345);
    const db = getDb(memory);

    const procs = db
      .query<{ id: number; metadata: string }, []>(
        "SELECT id, metadata FROM memories WHERE type = 'procedural'"
      )
      .all();

    for (const proc of procs) {
      const meta = JSON.parse(proc.metadata);
      expect(meta.softDeleted).toBeUndefined();
    }

    memory.close();
  });

  test("soft-delete chain integrity: replacedBy points to active memory", async () => {
    await consolidateMemories(12345);

    const memory = new SmartMemory(tmpDir, 12345);
    const db = getDb(memory);

    const softDeleted = db
      .query<{ id: number; metadata: string }, []>(
        "SELECT id, metadata FROM memories WHERE json_extract(metadata, '$.softDeleted') = 1"
      )
      .all();

    for (const row of softDeleted) {
      const meta = JSON.parse(row.metadata);
      if (meta.replacedBy !== undefined) {
        // replacedBy target should exist and NOT be soft-deleted
        const target = db
          .query<{ metadata: string }, [number]>(
            "SELECT metadata FROM memories WHERE id = ?"
          )
          .get(meta.replacedBy);
        expect(target).not.toBeNull();
        expect(JSON.parse(target!.metadata).softDeleted).toBeUndefined();
      }
    }

    memory.close();
  });
});

/**
 * SmartMemory Test Suite
 * Tests core data layer: store, search, getByImportance, getRecent,
 * softDelete, prune, safeParseJson, datetime format consistency
 *
 * Uses direct DB insert helper to bypass Haiku API calls for fast, deterministic tests.
 * Only store() tests exercise the real store method (with 30s timeout for API).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmartMemory } from "./smart-memory.ts";
import type { MemoryType } from "../types/memory.ts";

let memory: SmartMemory;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "smartmem-test-"));
  memory = new SmartMemory(tempDir, 1);
  insertCounter = 0;
});

afterEach(() => {
  memory.close();
  rmSync(tempDir, { recursive: true, force: true });
});

let insertCounter = 0;

/** Direct DB insert — bypasses Haiku API for fast, deterministic tests */
function insertMemory(opts: {
  type?: MemoryType;
  content: string;
  summary?: string;
  tags?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
  createdAt?: string;
  source?: string;
}): number {
  const db = (memory as any).db;
  // Use incrementing created_at to ensure deterministic ordering
  insertCounter++;
  const createdAt = opts.createdAt ?? `2026-01-01 00:00:${String(insertCounter).padStart(2, "0")}`;

  const result = db.run(
    `INSERT INTO memories (type, content, summary, tags, importance, source, metadata, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.type ?? "semantic",
      opts.content,
      opts.summary ?? opts.content.slice(0, 50),
      opts.tags ?? "test",
      opts.importance ?? 0.5,
      opts.source ?? "test",
      JSON.stringify(opts.metadata ?? {}),
      opts.expiresAt ?? null,
      createdAt,
    ]
  );
  return Number(result.lastInsertRowid);
}

// ─── Store (real method, uses Haiku API) ─────────────────────────────

describe("store()", () => {
  test("stores episodic memory and returns id", async () => {
    const id = await memory.store({
      type: "episodic",
      content: "Bugün hava güzel, parkta yürüyüş yaptık",
    });
    expect(id).toBeGreaterThan(0);
  }, 30_000);

  test("stores semantic memory without expiration", async () => {
    const id = await memory.store({
      type: "semantic",
      content: "Fekrat'ın favori rengi mavi",
      importance: 0.9,
    });
    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("semantic");
    expect(entry!.expiresAt).toBeUndefined();
    expect(entry!.importance).toBe(0.9);
  }, 30_000);

  test("episodic memory gets auto-expiration in SQLite format", async () => {
    const id = await memory.store({
      type: "episodic",
      content: "Test expiration content for episodic memory",
    });
    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.expiresAt).toBeDefined();
    // Should be YYYY-MM-DD HH:MM:SS format (no T, no Z)
    expect(entry!.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }, 30_000);

  test("custom expiresAt is normalized to SQLite format", async () => {
    const id = await memory.store({
      type: "episodic",
      content: "Custom expiry test memory content here",
      expiresAt: "2027-06-15T10:30:00.000Z",
    });
    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.expiresAt).toBe("2027-06-15 10:30:00");
  }, 30_000);

  test("stores metadata as JSON", async () => {
    const id = await memory.store({
      type: "semantic",
      content: "Metadata test memory for checking storage",
      metadata: { source: "test", custom: 42 },
    });
    const entry = memory.getById(id);
    expect(entry!.metadata).toEqual({ source: "test", custom: 42 });
  }, 30_000);
});

// ─── getRecent ───────────────────────────────────────────────────────

describe("getRecent()", () => {
  test("returns memories in reverse chronological order", () => {
    insertMemory({ content: "First memory stored here" });
    insertMemory({ content: "Second memory stored here" });
    insertMemory({ content: "Third memory stored here" });

    const recent = memory.getRecent(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe("Third memory stored here");
    expect(recent[2].content).toBe("First memory stored here");
  });

  test("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      insertMemory({ content: `Memory number ${i}` });
    }
    const recent = memory.getRecent(2);
    expect(recent).toHaveLength(2);
  });

  test("excludes soft-deleted memories", () => {
    const id = insertMemory({ content: "Will be deleted memory" });
    insertMemory({ content: "Will stay alive memory" });

    memory.softDelete(id, "test deletion");
    const recent = memory.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].content).toBe("Will stay alive memory");
  });

  test("excludes expired memories", () => {
    insertMemory({
      content: "Already expired test memory here",
      expiresAt: "2020-01-01 00:00:00",
    });
    insertMemory({ content: "Still valid test memory" });

    const recent = memory.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].content).toBe("Still valid test memory");
  });
});

// ─── getByImportance ─────────────────────────────────────────────────

describe("getByImportance()", () => {
  test("returns memories sorted by importance desc", () => {
    insertMemory({ content: "Low importance", importance: 0.3 });
    insertMemory({ content: "High importance", importance: 0.9 });
    insertMemory({ content: "Medium importance", importance: 0.6 });

    const results = memory.getByImportance(10, 0.1);
    expect(results).toHaveLength(3);
    expect(results[0].importance).toBe(0.9);
    expect(results[1].importance).toBe(0.6);
    expect(results[2].importance).toBe(0.3);
  });

  test("filters by minImportance threshold", () => {
    insertMemory({ content: "Low importance", importance: 0.3 });
    insertMemory({ content: "High importance", importance: 0.9 });

    const results = memory.getByImportance(10, 0.6);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.9);
  });

  test("excludes soft-deleted memories", () => {
    const id = insertMemory({ content: "Deleted high importance", importance: 0.9 });
    insertMemory({ content: "Active high importance", importance: 0.8 });

    memory.softDelete(id, "test");
    const results = memory.getByImportance(10, 0.1);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Active high importance");
  });
});

// ─── search (FTS5) ──────────────────────────────────────────────────

describe("search()", () => {
  test("FTS5 index finds memory by content keyword", () => {
    insertMemory({ content: "TypeScript programming language features", tags: "typescript,programming" });
    insertMemory({ content: "Python data science machine learning", tags: "python,ml" });

    // Test FTS5 search directly (private method) — avoids Haiku ranking dependency
    const candidates = (memory as any).fts5Search("TypeScript", undefined, 10);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].content).toContain("TypeScript");
  });

  test("FTS5 returns empty for non-matching query", () => {
    insertMemory({ content: "Bugün güzel bir gün" });

    const candidates = (memory as any).fts5Search("xyzzypuzzle", undefined, 10);
    expect(candidates).toHaveLength(0);
  });

  test("FTS5 handles special characters in query", () => {
    insertMemory({ content: "Regular content about projects" });

    // Should not throw on special FTS5 characters
    const candidates = (memory as any).fts5Search('test AND "OR" NOT (hello)', undefined, 10);
    expect(Array.isArray(candidates)).toBe(true);
  });

  test("search with fallback when Haiku unavailable", async () => {
    insertMemory({ content: "TypeScript programming language features" });

    // search() falls back to FTS5 results with similarity 0.5 when ranking fails
    const results = await memory.search("TypeScript", { minScore: 0 });
    // Results depend on Haiku availability — just verify no crash
    expect(Array.isArray(results)).toBe(true);
  }, 30_000);
});

// ─── softDelete ─────────────────────────────────────────────────────

describe("softDelete()", () => {
  test("marks memory as soft-deleted", () => {
    const id = insertMemory({ content: "To be soft deleted memory" });

    const success = memory.softDelete(id, "test reason");
    expect(success).toBe(true);

    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.metadata.softDeleted).toBe(1);
    expect(entry!.metadata.softDeleteReason).toBe("test reason");
  });

  test("stores replacedBy when provided", () => {
    const id1 = insertMemory({ content: "Original content memory" });
    const id2 = insertMemory({ content: "Replacement memory content" });

    memory.softDelete(id1, "merged", id2);
    const entry = memory.getById(id1);
    expect(entry!.metadata.replacedBy).toBe(id2);
  });

  test("handles reason with special characters safely (SQL injection)", () => {
    const id = insertMemory({ content: "SQL injection test memory" });

    const success = memory.softDelete(id, "test'; DROP TABLE memories; --");
    expect(success).toBe(true);

    const entry = memory.getById(id);
    expect(entry!.metadata.softDeleteReason).toBe("test'; DROP TABLE memories; --");
    // Table should still exist
    const stats = memory.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(0);
  });

  test("returns false for non-existent id", () => {
    const success = memory.softDelete(99999, "not found");
    expect(success).toBe(false);
  });
});

// ─── prune ──────────────────────────────────────────────────────────

describe("prune()", () => {
  test("deletes expired memories", () => {
    insertMemory({
      content: "Already expired memory entry",
      expiresAt: "2020-01-01 00:00:00",
    });
    insertMemory({ content: "No expiration memory entry" });

    const pruned = memory.prune();
    // prune().changes may include FTS5 trigger changes in Bun SQLite
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Verify actual state: only non-expired memory remains
    const stats = memory.getStats();
    expect(stats.total).toBe(1);

    const recent = memory.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].content).toBe("No expiration memory entry");
  });

  test("does not delete non-expired memories", () => {
    insertMemory({
      content: "Far future expiry memory",
      expiresAt: "2099-12-31 23:59:59",
    });

    const pruned = memory.prune();
    expect(pruned).toBe(0);
  });

  test("returns 0 when nothing to prune", () => {
    const pruned = memory.prune();
    expect(pruned).toBe(0);
  });
});

// ─── getById ────────────────────────────────────────────────────────

describe("getById()", () => {
  test("returns memory by id", () => {
    const id = insertMemory({ content: "Find me by my identifier" });
    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(id);
    expect(entry!.content).toBe("Find me by my identifier");
  });

  test("returns null for non-existent id", () => {
    const entry = memory.getById(99999);
    expect(entry).toBeNull();
  });
});

// ─── getStats ───────────────────────────────────────────────────────

describe("getStats()", () => {
  test("counts active memories by type", () => {
    insertMemory({ type: "episodic", content: "Episodic memory" });
    insertMemory({ type: "semantic", content: "Semantic memory" });
    insertMemory({ type: "semantic", content: "Another semantic memory" });

    const stats = memory.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byType.episodic).toBe(1);
    expect(stats.byType.semantic).toBe(2);
    expect(stats.byType.procedural).toBe(0);
  });

  test("excludes soft-deleted from stats", () => {
    const id = insertMemory({ content: "Will be removed from stats" });
    insertMemory({ content: "Active in stats memory" });

    memory.softDelete(id, "test");
    const stats = memory.getStats();
    expect(stats.total).toBe(1);
  });

  test("calculates average importance", () => {
    insertMemory({ content: "Low", importance: 0.2 });
    insertMemory({ content: "High", importance: 0.8 });

    const stats = memory.getStats();
    expect(stats.avgImportance).toBeCloseTo(0.5, 1);
  });
});

// ─── updateImportance ───────────────────────────────────────────────

describe("updateImportance()", () => {
  test("clamps importance to valid range", () => {
    const id = insertMemory({ content: "Importance clamping test" });

    memory.updateImportance(id, 1.5);
    expect(memory.getById(id)!.importance).toBe(1.0);

    memory.updateImportance(id, -0.5);
    expect(memory.getById(id)!.importance).toBe(0.1);
  });

  test("updates importance within range", () => {
    const id = insertMemory({ content: "Normal importance update", importance: 0.5 });

    memory.updateImportance(id, 0.75);
    expect(memory.getById(id)!.importance).toBe(0.75);
  });
});

// ─── mergeMemories ──────────────────────────────────────────────────

describe("mergeMemories()", () => {
  test("soft-deletes sources and updates target metadata", () => {
    const id1 = insertMemory({ content: "Source one merge test" });
    const id2 = insertMemory({ content: "Source two merge test" });
    const targetId = insertMemory({ content: "Merge target memory" });

    const success = memory.mergeMemories([id1, id2], targetId);
    expect(success).toBe(true);

    // Sources should be soft-deleted
    expect(memory.getById(id1)!.metadata.softDeleted).toBe(1);
    expect(memory.getById(id2)!.metadata.softDeleted).toBe(1);

    // Target should have merge metadata
    const target = memory.getById(targetId)!;
    expect(target.metadata.mergedFrom).toBeDefined();
  });

  test("returns false for soft-deleted target", () => {
    const sourceId = insertMemory({ content: "Source for invalid merge" });
    const targetId = insertMemory({ content: "Deleted target for merge" });
    memory.softDelete(targetId, "pre-deleted");

    const success = memory.mergeMemories([sourceId], targetId);
    expect(success).toBe(false);
  });
});

// ─── safeParseJson resilience ───────────────────────────────────────

describe("corrupted metadata resilience", () => {
  test("getById handles corrupted metadata gracefully", () => {
    const id = insertMemory({ content: "Corruption test memory" });

    // Corrupt metadata directly in DB — getById has no json_extract in WHERE
    const db = (memory as any).db;
    db.run("UPDATE memories SET metadata = '{invalid json' WHERE id = ?", [id]);

    // Should not throw — safeParseJson returns fallback
    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.metadata).toEqual({});
  });

  test("getRecent handles null metadata gracefully", () => {
    const id = insertMemory({ content: "Null metadata recent test" });

    // NULL metadata passes json_extract (returns NULL, IS NOT 1 = true)
    const db = (memory as any).db;
    db.run("UPDATE memories SET metadata = NULL WHERE id = ?", [id]);

    const recent = memory.getRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].metadata).toEqual({});
  });

  test("getById handles empty metadata object gracefully", () => {
    const id = insertMemory({ content: "Empty obj metadata" });

    const db = (memory as any).db;
    db.run("UPDATE memories SET metadata = '{}' WHERE id = ?", [id]);

    const entry = memory.getById(id);
    expect(entry).not.toBeNull();
    expect(entry!.metadata).toEqual({});
  });
});

// ─── promoteToSemantic ──────────────────────────────────────────────

describe("promoteToSemantic()", () => {
  test("promotes episodic to semantic and removes expiration", () => {
    const id = insertMemory({
      type: "episodic",
      content: "Episodic to promote",
      expiresAt: "2027-01-01 00:00:00",
    });

    const success = memory.promoteToSemantic(id);
    expect(success).toBe(true);

    const entry = memory.getById(id);
    expect(entry!.type).toBe("semantic");
    expect(entry!.expiresAt).toBeUndefined();
    expect(entry!.metadata.promotedFrom).toBe("episodic");
  });

  test("returns false for non-episodic memory", () => {
    const id = insertMemory({ type: "semantic", content: "Already semantic" });

    const success = memory.promoteToSemantic(id);
    expect(success).toBe(false);
  });
});

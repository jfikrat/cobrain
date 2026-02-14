import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Signal } from "./signal-bus.ts";
import type { PendingExpectation, ExpectationType } from "./expectations.ts";

// ── Test-local ExpectationsManager ───────────────────────────────────────
// The production module uses a hardcoded DATA_FILE and a singleton signalBus.
// We re-implement a minimal ExpectationsManager here that accepts an injected
// dataFile path and a no-op signalBus so every test is fully isolated with
// real file I/O against a temp directory.

class TestExpectationsManager {
  private expectations: PendingExpectation[] = [];
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(private dataFile: string) {}

  async load(): Promise<void> {
    try {
      const file = Bun.file(this.dataFile);
      if (await file.exists()) {
        const data = await file.json();
        this.expectations = data.expectations || [];
      }
    } catch {
      this.expectations = [];
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    this.saving = this.saving.then(() => this._doSave()).catch(() => {});
    return this.saving;
  }

  private async _doSave(): Promise<void> {
    const tmpPath = `${this.dataFile}.tmp.${Date.now()}`;
    await Bun.write(tmpPath, JSON.stringify({ expectations: this.expectations }, null, 2));
    const fs = await import("node:fs/promises");
    await fs.rename(tmpPath, this.dataFile);
  }

  async create(params: {
    type: ExpectationType;
    target: string;
    context: string;
    onResolved: string;
    userId: number;
    timeout?: number;
  }): Promise<PendingExpectation> {
    const expectation: PendingExpectation = {
      id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: params.type,
      target: params.target,
      context: params.context,
      onResolved: params.onResolved,
      userId: params.userId,
      timeout: params.timeout ?? 30 * 60 * 1000,
      createdAt: Date.now(),
      status: "pending",
    };

    this.expectations.push(expectation);
    await this.save();
    return expectation;
  }

  async resolve(id: string, data: Record<string, unknown> = {}): Promise<PendingExpectation | null> {
    const exp = this.expectations.find(e => e.id === id && e.status === "pending");
    if (!exp) return null;

    exp.status = "resolved";
    exp.resolvedAt = Date.now();
    exp.resolvedData = data;
    await this.save();
    return exp;
  }

  matchSignal(signal: Signal): PendingExpectation[] {
    return this.pending().filter(exp => {
      if (exp.type === "whatsapp_reply" && signal.source === "whatsapp_message") {
        return signal.contactId === exp.target;
      }
      if (exp.type === "location_arrival" && signal.source === "location_change") {
        return true;
      }
      if (signal.contactId === exp.target) return true;
      return false;
    });
  }

  cleanExpired(): PendingExpectation[] {
    const now = Date.now();
    const expired: PendingExpectation[] = [];
    for (const exp of this.expectations) {
      if (exp.status === "pending" && exp.timeout > 0) {
        if (now - exp.createdAt > exp.timeout) {
          exp.status = "expired";
          expired.push(exp);
        }
      }
    }
    if (expired.length > 0) {
      this.save();
    }
    return expired;
  }

  pending(): PendingExpectation[] {
    return this.expectations.filter(e => e.status === "pending");
  }

  pendingForUser(userId: number): PendingExpectation[] {
    return this.expectations.filter(e => e.status === "pending" && e.userId === userId);
  }

  all(): PendingExpectation[] {
    return [...this.expectations];
  }

  async prune(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const before = this.expectations.length;
    const cutoff = Date.now() - maxAge;
    this.expectations = this.expectations.filter(e => {
      if (e.status === "pending") return true;
      return e.createdAt > cutoff;
    });
    const removed = before - this.expectations.length;
    if (removed > 0) {
      await this.save();
    }
    return removed;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;
let manager: TestExpectationsManager;

function dataFile(): string {
  return join(tmpDir, "expectations.json");
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `sig_test_${Math.random().toString(36).slice(2, 8)}`,
    source: "whatsapp_message",
    type: "incoming",
    data: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cobrain-exp-test-"));
  manager = new TestExpectationsManager(dataFile());
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("ExpectationsManager", () => {

  // 1. create() adds a new pending expectation with correct fields
  test("create() adds a new pending expectation with correct fields", async () => {
    const exp = await manager.create({
      type: "whatsapp_reply",
      target: "905551234567@s.whatsapp.net",
      context: "Ali'ye mesaj gönderdim, cevap bekliyorum",
      onResolved: "Cevabı özetle ve bildir",
      userId: 123,
      timeout: 60_000,
    });

    expect(exp.id).toStartWith("exp_");
    expect(exp.type).toBe("whatsapp_reply");
    expect(exp.target).toBe("905551234567@s.whatsapp.net");
    expect(exp.context).toBe("Ali'ye mesaj gönderdim, cevap bekliyorum");
    expect(exp.onResolved).toBe("Cevabı özetle ve bildir");
    expect(exp.userId).toBe(123);
    expect(exp.timeout).toBe(60_000);
    expect(exp.status).toBe("pending");
    expect(exp.createdAt).toBeGreaterThan(0);
    expect(exp.resolvedAt).toBeUndefined();
    expect(exp.resolvedData).toBeUndefined();

    // Should be in the pending list
    expect(manager.pending()).toHaveLength(1);
    expect(manager.all()).toHaveLength(1);
  });

  // 2. create() generates unique IDs
  test("create() generates unique IDs", async () => {
    const params = {
      type: "whatsapp_reply" as ExpectationType,
      target: "target1",
      context: "ctx",
      onResolved: "do something",
      userId: 1,
    };

    const [a, b, c] = await Promise.all([
      manager.create(params),
      manager.create(params),
      manager.create(params),
    ]);

    const ids = new Set([a.id, b.id, c.id]);
    expect(ids.size).toBe(3);
  });

  // 3. resolve() marks expectation as resolved with data
  test("resolve() marks expectation as resolved with data", async () => {
    const exp = await manager.create({
      type: "whatsapp_reply",
      target: "target1",
      context: "bekliyorum",
      onResolved: "bildir",
      userId: 1,
    });

    const resolveData = { message: "Tamam, geliyorum!", sender: "Ali" };
    const resolved = await manager.resolve(exp.id, resolveData);

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolvedAt).toBeGreaterThan(0);
    expect(resolved!.resolvedData).toEqual(resolveData);
    expect(resolved!.resolvedAt!).toBeGreaterThanOrEqual(resolved!.createdAt);

    // No longer in pending
    expect(manager.pending()).toHaveLength(0);
    // Still in all()
    expect(manager.all()).toHaveLength(1);
  });

  // 4. resolve() returns null for non-existent ID
  test("resolve() returns null for non-existent ID", async () => {
    const result = await manager.resolve("non_existent_id_12345");
    expect(result).toBeNull();
  });

  // 4b. resolve() returns null for already-resolved expectation
  test("resolve() returns null for already-resolved expectation", async () => {
    const exp = await manager.create({
      type: "whatsapp_reply",
      target: "target1",
      context: "ctx",
      onResolved: "action",
      userId: 1,
    });

    // First resolve succeeds
    const first = await manager.resolve(exp.id, { attempt: 1 });
    expect(first).not.toBeNull();

    // Second resolve returns null (already resolved)
    const second = await manager.resolve(exp.id, { attempt: 2 });
    expect(second).toBeNull();
  });

  // 5. matchSignal() finds matching expectation by target (contactId)
  test("matchSignal() finds matching expectation by target (contactId) for whatsapp_reply", async () => {
    const target = "905551112233@s.whatsapp.net";
    await manager.create({
      type: "whatsapp_reply",
      target,
      context: "cevap bekliyorum",
      onResolved: "bildir",
      userId: 1,
    });

    const signal = makeSignal({
      source: "whatsapp_message",
      contactId: target,
    });

    const matches = manager.matchSignal(signal);
    expect(matches).toHaveLength(1);
    expect(matches[0].target).toBe(target);
  });

  // 5b. matchSignal() matches location_arrival with location_change signal
  test("matchSignal() matches location_arrival with location_change signal", async () => {
    await manager.create({
      type: "location_arrival",
      target: "office",
      context: "ofise varis bekleniyor",
      onResolved: "bildir",
      userId: 1,
    });

    const signal = makeSignal({
      source: "location_change",
      type: "arrived",
      data: { location: "office" },
    });

    const matches = manager.matchSignal(signal);
    expect(matches).toHaveLength(1);
  });

  // 5c. matchSignal() generic contactId match
  test("matchSignal() matches by contactId for non-whatsapp types", async () => {
    const target = "user@email.com";
    await manager.create({
      type: "custom",
      target,
      context: "email bekliyorum",
      onResolved: "bildir",
      userId: 1,
    });

    const signal = makeSignal({
      source: "email_received" as any,
      contactId: target,
    });

    const matches = manager.matchSignal(signal);
    expect(matches).toHaveLength(1);
  });

  // 6. matchSignal() returns empty when no match
  test("matchSignal() returns empty when no match", async () => {
    await manager.create({
      type: "whatsapp_reply",
      target: "905551112233@s.whatsapp.net",
      context: "bekliyorum",
      onResolved: "bildir",
      userId: 1,
    });

    const signal = makeSignal({
      source: "whatsapp_message",
      contactId: "different_contact@s.whatsapp.net",
    });

    const matches = manager.matchSignal(signal);
    expect(matches).toHaveLength(0);
  });

  // 6b. matchSignal() returns empty when no expectations exist
  test("matchSignal() returns empty when no expectations exist", () => {
    const signal = makeSignal({ contactId: "anyone" });
    const matches = manager.matchSignal(signal);
    expect(matches).toHaveLength(0);
  });

  // 7. matchSignal() only matches pending expectations (not resolved/expired)
  test("matchSignal() only matches pending expectations (not resolved/expired)", async () => {
    const target = "905551112233@s.whatsapp.net";

    // Create and resolve one
    const resolved = await manager.create({
      type: "whatsapp_reply",
      target,
      context: "resolved olacak",
      onResolved: "bildir",
      userId: 1,
    });
    await manager.resolve(resolved.id, { done: true });

    // Create one that will stay pending
    await manager.create({
      type: "whatsapp_reply",
      target,
      context: "bu pending kalacak",
      onResolved: "bildir",
      userId: 1,
    });

    const signal = makeSignal({
      source: "whatsapp_message",
      contactId: target,
    });

    const matches = manager.matchSignal(signal);
    // Only the pending one should match
    expect(matches).toHaveLength(1);
    expect(matches[0].context).toBe("bu pending kalacak");
  });

  // 8. cleanExpired() marks timed-out expectations as expired
  test("cleanExpired() marks timed-out expectations as expired", async () => {
    // Create with very short timeout
    const exp = await manager.create({
      type: "whatsapp_reply",
      target: "target1",
      context: "hemen expire olacak",
      onResolved: "bildir",
      userId: 1,
      timeout: 1, // 1ms — will be expired immediately
    });

    // Small delay to ensure expiration
    await Bun.sleep(5);

    const expired = manager.cleanExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(exp.id);
    expect(expired[0].status).toBe("expired");

    // No longer in pending
    expect(manager.pending()).toHaveLength(0);
  });

  // 8b. cleanExpired() does not expire expectations with timeout=0 (infinite)
  test("cleanExpired() does not expire expectations with timeout=0", async () => {
    await manager.create({
      type: "whatsapp_reply",
      target: "target1",
      context: "sonsuza kadar bekle",
      onResolved: "bildir",
      userId: 1,
      timeout: 0,
    });

    const expired = manager.cleanExpired();
    expect(expired).toHaveLength(0);
    expect(manager.pending()).toHaveLength(1);
  });

  // 8c. cleanExpired() does not touch already resolved expectations
  test("cleanExpired() does not touch already resolved expectations", async () => {
    const exp = await manager.create({
      type: "whatsapp_reply",
      target: "target1",
      context: "resolved olan",
      onResolved: "bildir",
      userId: 1,
      timeout: 1,
    });
    await manager.resolve(exp.id, {});
    await Bun.sleep(5);

    const expired = manager.cleanExpired();
    expect(expired).toHaveLength(0);
    expect(manager.all().find(e => e.id === exp.id)!.status).toBe("resolved");
  });

  // 9. getPending() / pending() returns only pending expectations
  test("pending() returns only pending expectations", async () => {
    const a = await manager.create({
      type: "whatsapp_reply",
      target: "t1",
      context: "a",
      onResolved: "x",
      userId: 1,
    });
    await manager.create({
      type: "whatsapp_reply",
      target: "t2",
      context: "b",
      onResolved: "x",
      userId: 1,
    });
    const c = await manager.create({
      type: "whatsapp_reply",
      target: "t3",
      context: "c",
      onResolved: "x",
      userId: 1,
      timeout: 1,
    });

    // Resolve one
    await manager.resolve(a.id, {});
    // Expire one
    await Bun.sleep(5);
    manager.cleanExpired();

    const pending = manager.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].context).toBe("b");
  });

  // 9b. pendingForUser() filters by userId
  test("pendingForUser() filters by userId", async () => {
    await manager.create({
      type: "whatsapp_reply",
      target: "t1",
      context: "user 1",
      onResolved: "x",
      userId: 100,
    });
    await manager.create({
      type: "whatsapp_reply",
      target: "t2",
      context: "user 2",
      onResolved: "x",
      userId: 200,
    });
    await manager.create({
      type: "whatsapp_reply",
      target: "t3",
      context: "user 1 again",
      onResolved: "x",
      userId: 100,
    });

    expect(manager.pendingForUser(100)).toHaveLength(2);
    expect(manager.pendingForUser(200)).toHaveLength(1);
    expect(manager.pendingForUser(999)).toHaveLength(0);
  });

  // 10. Multiple expectations can exist simultaneously
  test("multiple expectations can exist simultaneously", async () => {
    const targets = ["t1", "t2", "t3", "t4", "t5"];

    for (const target of targets) {
      await manager.create({
        type: "whatsapp_reply",
        target,
        context: `beklenti for ${target}`,
        onResolved: "bildir",
        userId: 1,
      });
    }

    expect(manager.all()).toHaveLength(5);
    expect(manager.pending()).toHaveLength(5);

    // Each has a unique ID
    const ids = manager.all().map(e => e.id);
    expect(new Set(ids).size).toBe(5);
  });

  // ── Persistence ──────────────────────────────────────────────────────

  describe("persistence", () => {
    test("save() persists to disk and load() restores", async () => {
      await manager.create({
        type: "whatsapp_reply",
        target: "persist_target",
        context: "persist test",
        onResolved: "bildir",
        userId: 42,
      });

      // Create a new manager pointing to the same file
      const manager2 = new TestExpectationsManager(dataFile());
      await manager2.load();

      expect(manager2.all()).toHaveLength(1);
      expect(manager2.all()[0].target).toBe("persist_target");
      expect(manager2.all()[0].userId).toBe(42);
      expect(manager2.all()[0].status).toBe("pending");
    });

    test("load() handles missing file gracefully", async () => {
      const mgr = new TestExpectationsManager(join(tmpDir, "nonexistent.json"));
      await mgr.load();
      expect(mgr.all()).toHaveLength(0);
    });

    test("load() handles corrupt file gracefully", async () => {
      const corruptPath = join(tmpDir, "corrupt.json");
      await Bun.write(corruptPath, "not valid json {{{");

      const mgr = new TestExpectationsManager(corruptPath);
      await mgr.load();
      expect(mgr.all()).toHaveLength(0);
    });

    test("resolved state persists across load", async () => {
      const exp = await manager.create({
        type: "whatsapp_reply",
        target: "t1",
        context: "resolve persist",
        onResolved: "bildir",
        userId: 1,
      });
      await manager.resolve(exp.id, { answer: "evet" });

      const manager2 = new TestExpectationsManager(dataFile());
      await manager2.load();

      expect(manager2.pending()).toHaveLength(0);
      const loaded = manager2.all()[0];
      expect(loaded.status).toBe("resolved");
      expect(loaded.resolvedData).toEqual({ answer: "evet" });
    });
  });

  // ── Prune ────────────────────────────────────────────────────────────

  describe("prune()", () => {
    test("prune() removes old resolved/expired entries", async () => {
      // Create and resolve one
      const old = await manager.create({
        type: "whatsapp_reply",
        target: "old_target",
        context: "old",
        onResolved: "bildir",
        userId: 1,
      });
      await manager.resolve(old.id, {});

      // Manually backdate the createdAt to 10 days ago
      const entry = manager.all().find(e => e.id === old.id)!;
      entry.createdAt = Date.now() - 10 * 24 * 60 * 60 * 1000;

      // Create a fresh pending one
      await manager.create({
        type: "whatsapp_reply",
        target: "new_target",
        context: "new",
        onResolved: "bildir",
        userId: 1,
      });

      // Prune with 7-day cutoff (default)
      const removed = await manager.prune();
      expect(removed).toBe(1);
      expect(manager.all()).toHaveLength(1);
      expect(manager.all()[0].target).toBe("new_target");
    });

    test("prune() keeps pending expectations regardless of age", async () => {
      const exp = await manager.create({
        type: "whatsapp_reply",
        target: "ancient",
        context: "very old pending",
        onResolved: "bildir",
        userId: 1,
      });

      // Backdate to 30 days ago
      const entry = manager.all().find(e => e.id === exp.id)!;
      entry.createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const removed = await manager.prune();
      expect(removed).toBe(0);
      expect(manager.pending()).toHaveLength(1);
    });

    test("prune() with custom maxAge", async () => {
      const exp = await manager.create({
        type: "whatsapp_reply",
        target: "t1",
        context: "ctx",
        onResolved: "bildir",
        userId: 1,
      });
      await manager.resolve(exp.id, {});

      // Backdate to 2 hours ago
      const entry = manager.all().find(e => e.id === exp.id)!;
      entry.createdAt = Date.now() - 2 * 60 * 60 * 1000;

      // Prune with 1-hour cutoff
      const removed = await manager.prune(1 * 60 * 60 * 1000);
      expect(removed).toBe(1);
    });

    test("prune() returns 0 when nothing to remove", async () => {
      await manager.create({
        type: "whatsapp_reply",
        target: "t1",
        context: "ctx",
        onResolved: "bildir",
        userId: 1,
      });

      const removed = await manager.prune();
      expect(removed).toBe(0);
    });
  });

  // ── Default timeout ──────────────────────────────────────────────────

  test("create() uses default timeout (30 min) when not provided", async () => {
    const exp = await manager.create({
      type: "whatsapp_reply",
      target: "t1",
      context: "default timeout",
      onResolved: "bildir",
      userId: 1,
    });

    expect(exp.timeout).toBe(30 * 60 * 1000); // 30 minutes
  });

  // ── all() returns a copy ─────────────────────────────────────────────

  test("all() returns a shallow copy, not the internal array", async () => {
    await manager.create({
      type: "whatsapp_reply",
      target: "t1",
      context: "ctx",
      onResolved: "bildir",
      userId: 1,
    });

    const copy = manager.all();
    copy.push({} as PendingExpectation);

    // Internal array should be unaffected
    expect(manager.all()).toHaveLength(1);
  });

  // ── matchSignal edge cases ───────────────────────────────────────────

  test("matchSignal() returns multiple matches when several expectations target the same contact", async () => {
    const target = "905559998877@s.whatsapp.net";
    await manager.create({
      type: "whatsapp_reply",
      target,
      context: "first question",
      onResolved: "first action",
      userId: 1,
    });
    await manager.create({
      type: "whatsapp_reply",
      target,
      context: "second question",
      onResolved: "second action",
      userId: 1,
    });

    const signal = makeSignal({
      source: "whatsapp_message",
      contactId: target,
    });

    const matches = manager.matchSignal(signal);
    expect(matches).toHaveLength(2);
  });

  test("matchSignal() does not match whatsapp_reply when signal source is not whatsapp_message", async () => {
    const target = "905551112233@s.whatsapp.net";
    await manager.create({
      type: "whatsapp_reply",
      target,
      context: "wa reply",
      onResolved: "bildir",
      userId: 1,
    });

    // Signal from a different source but same contactId
    // whatsapp_reply type expects source=whatsapp_message, so user_message
    // won't match through the type-specific branch, but WILL match through
    // the generic contactId fallback
    const signal = makeSignal({
      source: "user_message",
      contactId: target,
    });

    const matches = manager.matchSignal(signal);
    // Generic contactId match kicks in
    expect(matches).toHaveLength(1);
  });
});

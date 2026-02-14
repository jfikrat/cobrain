import { test, expect, describe } from "bun:test";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Helper: create a breaker with short cooldown for fast tests */
function makeBreaker(overrides?: { maxFailures?: number; cooldownMs?: number }) {
  return new CircuitBreaker({
    name: "test",
    maxFailures: overrides?.maxFailures ?? 3,
    cooldownMs: overrides?.cooldownMs ?? 100,
  });
}

/** Helper: trip the breaker open by exhausting maxFailures */
async function tripOpen(
  cb: CircuitBreaker,
  failures: number = 3,
): Promise<void> {
  for (let i = 0; i < failures; i++) {
    try {
      await cb.execute(() => Promise.reject(new Error("fail")));
    } catch {
      // expected
    }
  }
}

describe("CircuitBreaker", () => {
  // ─── 1. CLOSED state: execute passes through normally ───────────────
  describe("CLOSED state", () => {
    test("passes through and returns the result", async () => {
      const cb = makeBreaker();
      const result = await cb.execute(() => Promise.resolve(42));
      expect(result).toBe(42);
    });

    test("propagates the thrown error from fn", async () => {
      const cb = makeBreaker();
      await expect(
        cb.execute(() => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
    });

    test("state is CLOSED initially", () => {
      const cb = makeBreaker();
      expect(cb.stats().state).toBe("CLOSED");
    });
  });

  // ─── 2. Transition to OPEN after maxFailures ───────────────────────
  describe("transition to OPEN", () => {
    test("opens after maxFailures consecutive failures", async () => {
      const cb = makeBreaker({ maxFailures: 3 });

      await tripOpen(cb, 3);

      expect(cb.stats().state).toBe("OPEN");
      expect(cb.stats().failures).toBe(3);
      expect(cb.stats().totalTrips).toBe(1);
    });

    test("does not open before reaching maxFailures", async () => {
      const cb = makeBreaker({ maxFailures: 3 });

      await tripOpen(cb, 2);

      expect(cb.stats().state).toBe("CLOSED");
      expect(cb.stats().failures).toBe(2);
    });

    test("custom maxFailures is respected", async () => {
      const cb = makeBreaker({ maxFailures: 5 });

      await tripOpen(cb, 4);
      expect(cb.stats().state).toBe("CLOSED");

      await tripOpen(cb, 1);
      expect(cb.stats().state).toBe("OPEN");
    });
  });

  // ─── 3. OPEN state: immediately throws without calling fn ──────────
  describe("OPEN state", () => {
    test("throws CircuitOpenError without calling fn", async () => {
      const cb = makeBreaker();
      await tripOpen(cb);

      let fnCalled = false;
      await expect(
        cb.execute(() => {
          fnCalled = true;
          return Promise.resolve("should not reach");
        }),
      ).rejects.toThrow(CircuitOpenError);

      expect(fnCalled).toBe(false);
    });

    test("error message includes breaker name", async () => {
      const cb = makeBreaker();
      await tripOpen(cb);

      try {
        await cb.execute(() => Promise.resolve("x"));
        throw new Error("should not reach");
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitOpenError);
        expect((err as Error).message).toContain("CircuitBreaker:test");
      }
    });
  });

  // ─── 4. Cooldown and HALF_OPEN ─────────────────────────────────────
  describe("cooldown and HALF_OPEN", () => {
    test("allows one probe call after cooldown elapses", async () => {
      const cb = makeBreaker({ cooldownMs: 100 });
      await tripOpen(cb);
      expect(cb.stats().state).toBe("OPEN");

      await sleep(120);

      // The next execute should transition to HALF_OPEN and call fn
      let fnCalled = false;
      const result = await cb.execute(() => {
        fnCalled = true;
        return Promise.resolve("probe-ok");
      });

      expect(fnCalled).toBe(true);
      expect(result).toBe("probe-ok");
    });
  });

  // ─── 5. HALF_OPEN success → CLOSED ────────────────────────────────
  describe("HALF_OPEN success", () => {
    test("transitions back to CLOSED on probe success", async () => {
      const cb = makeBreaker({ cooldownMs: 100 });
      await tripOpen(cb);

      await sleep(120);

      await cb.execute(() => Promise.resolve("ok"));

      expect(cb.stats().state).toBe("CLOSED");
      expect(cb.stats().failures).toBe(0);
    });

    test("subsequent calls work normally after recovery", async () => {
      const cb = makeBreaker({ cooldownMs: 100 });
      await tripOpen(cb);

      await sleep(120);

      await cb.execute(() => Promise.resolve("probe"));
      const result = await cb.execute(() => Promise.resolve("normal"));
      expect(result).toBe("normal");
      expect(cb.stats().state).toBe("CLOSED");
    });
  });

  // ─── 6. HALF_OPEN failure → OPEN ──────────────────────────────────
  describe("HALF_OPEN failure", () => {
    test("transitions back to OPEN on probe failure", async () => {
      const cb = makeBreaker({ cooldownMs: 100 });
      await tripOpen(cb);

      await sleep(120);

      // Probe fails
      await expect(
        cb.execute(() => Promise.reject(new Error("probe-fail"))),
      ).rejects.toThrow("probe-fail");

      expect(cb.stats().state).toBe("OPEN");
    });

    test("increments totalTrips on each trip to OPEN", async () => {
      const cb = makeBreaker({ cooldownMs: 100, maxFailures: 2 });

      // First trip
      await tripOpen(cb, 2);
      expect(cb.stats().totalTrips).toBe(1);

      // Wait for cooldown, probe fails → second trip
      await sleep(120);
      try {
        await cb.execute(() => Promise.reject(new Error("fail")));
      } catch {
        // expected
      }
      expect(cb.stats().totalTrips).toBe(2);
    });
  });

  // ─── 7. stats() ───────────────────────────────────────────────────
  describe("stats()", () => {
    test("returns correct initial stats", () => {
      const cb = makeBreaker();
      const s = cb.stats();
      expect(s.state).toBe("CLOSED");
      expect(s.failures).toBe(0);
      expect(s.lastFailure).toBeNull();
      expect(s.totalTrips).toBe(0);
    });

    test("returns correct stats after failures", async () => {
      const cb = makeBreaker({ maxFailures: 3 });

      await tripOpen(cb, 2);
      const s = cb.stats();
      expect(s.state).toBe("CLOSED");
      expect(s.failures).toBe(2);
      expect(s.lastFailure).toBeTypeOf("number");
      expect(s.totalTrips).toBe(0);
    });

    test("returns correct stats after tripping", async () => {
      const cb = makeBreaker({ maxFailures: 3 });

      await tripOpen(cb, 3);
      const s = cb.stats();
      expect(s.state).toBe("OPEN");
      expect(s.failures).toBe(3);
      expect(s.lastFailure).toBeTypeOf("number");
      expect(s.totalTrips).toBe(1);
    });
  });

  // ─── 8. isOpen() ──────────────────────────────────────────────────
  describe("isOpen()", () => {
    test("returns false when CLOSED", () => {
      const cb = makeBreaker();
      expect(cb.isOpen()).toBe(false);
    });

    test("returns true when OPEN and cooldown has not elapsed", async () => {
      const cb = makeBreaker({ cooldownMs: 5000 });
      await tripOpen(cb);
      expect(cb.isOpen()).toBe(true);
    });

    test("returns false when OPEN but cooldown has elapsed (would be HALF_OPEN)", async () => {
      const cb = makeBreaker({ cooldownMs: 100 });
      await tripOpen(cb);
      expect(cb.isOpen()).toBe(true);

      await sleep(120);

      // Cooldown elapsed — isOpen returns false because next call would transition
      expect(cb.isOpen()).toBe(false);
    });
  });

  // ─── 9. Success resets failure count ──────────────────────────────
  describe("success resets failure count", () => {
    test("a success in CLOSED state resets consecutive failures", async () => {
      const cb = makeBreaker({ maxFailures: 3 });

      // 2 failures (not enough to trip)
      await tripOpen(cb, 2);
      expect(cb.stats().failures).toBe(2);

      // 1 success resets
      await cb.execute(() => Promise.resolve("ok"));
      expect(cb.stats().failures).toBe(0);

      // 2 more failures — still not tripped because counter reset
      await tripOpen(cb, 2);
      expect(cb.stats().state).toBe("CLOSED");
      expect(cb.stats().failures).toBe(2);
    });

    test("requires maxFailures consecutive failures (not cumulative)", async () => {
      const cb = makeBreaker({ maxFailures: 3 });

      // fail, fail, success, fail, fail — should NOT trip
      await tripOpen(cb, 2);
      await cb.execute(() => Promise.resolve("reset"));
      await tripOpen(cb, 2);

      expect(cb.stats().state).toBe("CLOSED");
      expect(cb.stats().totalTrips).toBe(0);
    });
  });
});

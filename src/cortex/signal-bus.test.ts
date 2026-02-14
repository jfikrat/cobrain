import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { signalBus, type Signal, type SignalSource } from "./signal-bus";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Reset signal bus state between tests */
function resetBus() {
  if (signalBus.isRunning()) signalBus.stop();
  signalBus.clearLog();
  signalBus.removeAllListeners();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SignalBus", () => {
  beforeEach(() => {
    resetBus();
  });

  afterEach(() => {
    resetBus();
  });

  // 1. push() creates a signal with correct fields
  describe("push()", () => {
    test("creates a signal with correct fields", () => {
      const signal = signalBus.push("whatsapp_message", "incoming", {
        text: "hello",
      });

      expect(signal.id).toStartWith("sig_");
      expect(signal.source).toBe("whatsapp_message");
      expect(signal.type).toBe("incoming");
      expect(signal.data).toEqual({ text: "hello" });
      expect(signal.timestamp).toBeGreaterThan(0);
      expect(typeof signal.timestamp).toBe("number");
    });

    test("generates unique IDs for each signal", () => {
      const s1 = signalBus.push("user_message", "text", {});
      const s2 = signalBus.push("user_message", "text", {});
      expect(s1.id).not.toBe(s2.id);
    });

    test("uses empty object as default data", () => {
      const signal = signalBus.push("time_tick", "hourly");
      expect(signal.data).toEqual({});
    });

    // 10. push() returns the created signal
    test("returns the created signal", () => {
      const signal = signalBus.push("system_event", "test", { key: "val" });
      expect(signal).toBeDefined();
      expect(signal.source).toBe("system_event");
      expect(signal.type).toBe("test");
    });

    // 9. Signal with contactId is stored correctly
    test("stores contactId when provided via extra", () => {
      const signal = signalBus.push(
        "whatsapp_message",
        "incoming",
        { text: "merhaba" },
        { contactId: "905551234567" },
      );

      expect(signal.contactId).toBe("905551234567");
    });

    test("stores userId when provided via extra", () => {
      const signal = signalBus.push(
        "user_message",
        "text",
        { text: "test" },
        { userId: 42 },
      );

      expect(signal.userId).toBe(42);
    });

    test("stores both contactId and userId when provided", () => {
      const signal = signalBus.push(
        "whatsapp_message",
        "incoming",
        {},
        { contactId: "c1", userId: 7 },
      );

      expect(signal.contactId).toBe("c1");
      expect(signal.userId).toBe(7);
    });
  });

  // 2. push() emits "signal" event to listeners
  describe("event emission", () => {
    test("emits 'signal' event to listener on push", () => {
      const received: Signal[] = [];
      signalBus.on("signal", (s) => received.push(s));

      const pushed = signalBus.push("user_message", "text", { msg: "hi" });

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(pushed.id);
      expect(received[0].source).toBe("user_message");
    });

    // 8. Multiple listeners receive the same signal
    test("multiple listeners all receive the same signal", () => {
      const received1: Signal[] = [];
      const received2: Signal[] = [];
      const received3: Signal[] = [];

      signalBus.on("signal", (s) => received1.push(s));
      signalBus.on("signal", (s) => received2.push(s));
      signalBus.on("signal", (s) => received3.push(s));

      const pushed = signalBus.push("time_tick", "minute", {});

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received3).toHaveLength(1);
      expect(received1[0].id).toBe(pushed.id);
      expect(received2[0].id).toBe(pushed.id);
      expect(received3[0].id).toBe(pushed.id);
    });

    test("listener is not called for signals pushed before subscription", () => {
      signalBus.push("user_message", "text", {});

      const received: Signal[] = [];
      signalBus.on("signal", (s) => received.push(s));

      expect(received).toHaveLength(0);
    });
  });

  // 3 & 4. Ring buffer log behavior
  describe("signal log (ring buffer)", () => {
    test("stores pushed signals in the log", () => {
      signalBus.push("user_message", "a", {});
      signalBus.push("user_message", "b", {});
      signalBus.push("user_message", "c", {});

      const log = signalBus.recent(10);
      expect(log).toHaveLength(3);
    });

    // 4. Old signals are dropped when log exceeds maxLogSize (200)
    test("drops oldest signals when log exceeds maxLogSize", () => {
      // Push 210 signals — first 10 should be evicted
      for (let i = 0; i < 210; i++) {
        signalBus.push("time_tick", `tick_${i}`, { index: i });
      }

      const log = signalBus.recent(300); // ask for more than exists
      expect(log).toHaveLength(200);

      // First signal in log should be tick_10 (0-9 evicted)
      expect(log[0].type).toBe("tick_10");
      // Last signal should be tick_209
      expect(log[199].type).toBe("tick_209");
    });

    // 5. getLog() / recent() returns signals in order
    test("recent() returns signals in chronological order", () => {
      signalBus.push("user_message", "first", {});
      signalBus.push("user_message", "second", {});
      signalBus.push("user_message", "third", {});

      const log = signalBus.recent(3);
      expect(log[0].type).toBe("first");
      expect(log[1].type).toBe("second");
      expect(log[2].type).toBe("third");
    });

    test("recent() returns only last N signals", () => {
      signalBus.push("user_message", "a", {});
      signalBus.push("user_message", "b", {});
      signalBus.push("user_message", "c", {});

      const log = signalBus.recent(2);
      expect(log).toHaveLength(2);
      expect(log[0].type).toBe("b");
      expect(log[1].type).toBe("c");
    });

    test("recent() defaults to 20 signals", () => {
      for (let i = 0; i < 30; i++) {
        signalBus.push("time_tick", `t_${i}`, {});
      }

      const log = signalBus.recent();
      expect(log).toHaveLength(20);
    });

    test("clearLog() empties the signal log", () => {
      signalBus.push("user_message", "test", {});
      signalBus.push("user_message", "test2", {});
      expect(signalBus.recent(10)).toHaveLength(2);

      signalBus.clearLog();
      expect(signalBus.recent(10)).toHaveLength(0);
    });
  });

  // Filtering methods
  describe("recentBySource()", () => {
    test("filters signals by source", () => {
      signalBus.push("whatsapp_message", "incoming", {});
      signalBus.push("user_message", "text", {});
      signalBus.push("whatsapp_message", "outgoing", {});
      signalBus.push("time_tick", "minute", {});

      const waSignals = signalBus.recentBySource("whatsapp_message");
      expect(waSignals).toHaveLength(2);
      expect(waSignals[0].type).toBe("incoming");
      expect(waSignals[1].type).toBe("outgoing");
    });

    test("returns empty array when no signals match source", () => {
      signalBus.push("user_message", "text", {});
      const result = signalBus.recentBySource("location_change");
      expect(result).toHaveLength(0);
    });

    test("respects count parameter", () => {
      signalBus.push("time_tick", "a", {});
      signalBus.push("time_tick", "b", {});
      signalBus.push("time_tick", "c", {});

      const result = signalBus.recentBySource("time_tick", 2);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("b");
      expect(result[1].type).toBe("c");
    });
  });

  describe("recentByContact()", () => {
    test("filters signals by contactId", () => {
      signalBus.push("whatsapp_message", "in", {}, { contactId: "alice" });
      signalBus.push("whatsapp_message", "in", {}, { contactId: "bob" });
      signalBus.push("whatsapp_message", "in", {}, { contactId: "alice" });

      const aliceSignals = signalBus.recentByContact("alice");
      expect(aliceSignals).toHaveLength(2);
    });

    test("returns empty array when contactId has no signals", () => {
      signalBus.push("user_message", "text", {});
      const result = signalBus.recentByContact("nonexistent");
      expect(result).toHaveLength(0);
    });
  });

  // 6. stats() returns correct counts
  describe("stats()", () => {
    test("returns correct total and bySource counts", () => {
      signalBus.push("whatsapp_message", "in", {});
      signalBus.push("whatsapp_message", "out", {});
      signalBus.push("user_message", "text", {});
      signalBus.push("time_tick", "minute", {});

      const s = signalBus.stats();
      expect(s.total).toBe(4);
      expect(s.bySource["whatsapp_message"]).toBe(2);
      expect(s.bySource["user_message"]).toBe(1);
      expect(s.bySource["time_tick"]).toBe(1);
    });

    test("returns zero total for empty log", () => {
      const s = signalBus.stats();
      expect(s.total).toBe(0);
      expect(s.bySource).toEqual({});
    });

    test("reflects log after eviction", () => {
      // Fill 200 with time_tick, then add 5 user_message (evicts 5 time_ticks)
      for (let i = 0; i < 200; i++) {
        signalBus.push("time_tick", "t", {});
      }
      for (let i = 0; i < 5; i++) {
        signalBus.push("user_message", "m", {});
      }

      const s = signalBus.stats();
      expect(s.total).toBe(200);
      expect(s.bySource["time_tick"]).toBe(195);
      expect(s.bySource["user_message"]).toBe(5);
    });
  });

  // 7. start() and stop() lifecycle
  describe("lifecycle", () => {
    test("start() sets running state to true", () => {
      expect(signalBus.isRunning()).toBe(false);
      signalBus.start();
      expect(signalBus.isRunning()).toBe(true);
    });

    test("start() emits a bus_started system_event signal", () => {
      const received: Signal[] = [];
      signalBus.on("signal", (s) => received.push(s));

      signalBus.start();

      expect(received).toHaveLength(1);
      expect(received[0].source).toBe("system_event");
      expect(received[0].type).toBe("bus_started");
    });

    test("start() is idempotent — calling twice does not emit twice", () => {
      const received: Signal[] = [];
      signalBus.on("signal", (s) => received.push(s));

      signalBus.start();
      signalBus.start(); // second call should be no-op

      expect(received).toHaveLength(1);
      expect(signalBus.isRunning()).toBe(true);
    });

    test("stop() sets running state to false", () => {
      signalBus.start();
      expect(signalBus.isRunning()).toBe(true);

      signalBus.stop();
      expect(signalBus.isRunning()).toBe(false);
    });

    test("stop() removes all listeners", () => {
      signalBus.start(); // must be started for stop() to execute

      const received: Signal[] = [];
      signalBus.on("signal", (s) => received.push(s));

      signalBus.push("user_message", "before_stop", {});
      expect(received).toHaveLength(1);

      signalBus.stop();
      signalBus.push("user_message", "after_stop", {});

      // Listener was removed by stop(), so no new signal received
      expect(received).toHaveLength(1);
    });

    test("stop() is idempotent — calling twice is safe", () => {
      signalBus.start();
      signalBus.stop();
      signalBus.stop(); // second call should be no-op
      expect(signalBus.isRunning()).toBe(false);
    });

    test("can restart after stop", () => {
      signalBus.start();
      signalBus.stop();

      // Re-attach listener after stop (since stop removes all)
      const received: Signal[] = [];
      signalBus.on("signal", (s) => received.push(s));

      signalBus.start();
      expect(signalBus.isRunning()).toBe(true);
      // bus_started signal should be received
      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("bus_started");
    });
  });
});

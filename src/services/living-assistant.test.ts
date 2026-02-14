/**
 * LivingAssistant Core Decision Tests
 * Tests makeQuickDecision() with deterministic fixtures.
 * Covers: overdue reminders, imminent reminders, today deadline,
 * goal follow-up, quiet hours, cooldown interactions.
 */

import { test, expect, describe, beforeEach, afterEach, setSystemTime } from "bun:test";
import { makeQuickDecision, type ContextData } from "./living-assistant.ts";

/** Create a base context with sensible defaults (no urgency) */
function baseContext(overrides?: Partial<ContextData>): ContextData {
  return {
    time: { hour: 14, dayOfWeek: 3, dayName: "Çarşamba", timeOfDay: "afternoon" },
    goals: { active: 2, approaching: [], needingFollowup: [] },
    reminders: { pending: 0, upcoming: [], overdue: [] },
    lastInteraction: { minutesAgo: 45, wasRecent: false },
    mood: { current: null, trend: "stable", averageEnergy: 3 },
    patterns: { isOptimalTime: true, currentSlotScore: 0.7 },
    memoryFollowups: [],
    ...overrides,
  };
}

beforeEach(() => {
  // Set time to 14:00 (not quiet hours)
  setSystemTime(new Date("2026-02-14T14:00:00Z"));
});

afterEach(() => {
  setSystemTime(); // Restore real time
});

// ─── No action scenarios ────────────────────────────────────────────

describe("no action needed", () => {
  test("returns shouldNotify false when context is calm", () => {
    const decision = makeQuickDecision(baseContext());
    expect(decision.shouldNotify).toBe(false);
    expect(decision.type).toBe("none");
    expect(decision.reason).toBe("no_urgent_action");
  });

  test("returns shouldNotify false when goals exist but no deadline today", () => {
    const ctx = baseContext({
      goals: {
        active: 3,
        approaching: [{ id: 1, title: "Proje X", dueDate: "2026-02-17", daysLeft: 3 }],
        needingFollowup: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(false);
  });
});

// ─── Overdue reminders ──────────────────────────────────────────────

describe("overdue reminders", () => {
  test("triggers urgent notification for overdue reminder", () => {
    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [],
        overdue: [{ title: "Doktora git", triggerAt: "2026-02-14T10:00:00Z" }],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.priority).toBe("urgent");
    expect(decision.type).toBe("nudge");
    expect(decision.message).toContain("Doktora git");
  });

  test("skips overdue reminder during quiet hours (non-urgent)", () => {
    // Set time to 2 AM (quiet hours)
    setSystemTime(new Date("2026-02-14T02:00:00Z"));

    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [],
        // Overdue by only 2 hours (not urgent — <24h)
        overdue: [{ title: "Yemek al", triggerAt: "2026-02-14T00:00:00Z" }],
      },
    });
    const decision = makeQuickDecision(ctx);
    // Non-urgent overdue should be suppressed during quiet hours
    expect(decision.shouldNotify).toBe(false);
  });

  test("allows urgent overdue (>24h) during quiet hours", () => {
    // Set time to 2 AM (quiet hours)
    setSystemTime(new Date("2026-02-15T02:00:00Z"));

    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [],
        // Overdue by >24 hours
        overdue: [{ title: "Fatura öde", triggerAt: "2026-02-13T12:00:00Z" }],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.priority).toBe("urgent");
    expect(decision.message).toContain("Fatura öde");
  });
});

// ─── Imminent reminders ─────────────────────────────────────────────

describe("imminent reminders", () => {
  test("triggers high priority for reminder in 3 minutes", () => {
    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [{ title: "Toplantı", triggerAt: "2026-02-14T14:03:00Z", minutesLeft: 3 }],
        overdue: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.priority).toBe("high");
    expect(decision.type).toBe("nudge");
    expect(decision.message).toContain("3 dakika");
    expect(decision.message).toContain("Toplantı");
  });

  test("skips reminder >5 minutes away", () => {
    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [{ title: "Toplantı", triggerAt: "2026-02-14T14:20:00Z", minutesLeft: 20 }],
        overdue: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(false);
  });

  test("skips imminent reminders during quiet hours", () => {
    setSystemTime(new Date("2026-02-14T02:00:00Z"));

    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [{ title: "Gece hatırlatma", triggerAt: "2026-02-14T02:03:00Z", minutesLeft: 3 }],
        overdue: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(false);
  });
});

// ─── Today deadline ─────────────────────────────────────────────────

describe("today deadline", () => {
  test("triggers high priority for goal with today deadline", () => {
    const ctx = baseContext({
      goals: {
        active: 2,
        approaching: [{ id: 42, title: "Blog yazısı", dueDate: "2026-02-14", daysLeft: 0 }],
        needingFollowup: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.priority).toBe("high");
    expect(decision.type).toBe("goal_followup");
    expect(decision.goalId).toBe(42);
    expect(decision.message).toContain("Blog yazısı");
  });

  test("today deadline includes goalId for followup tracking", () => {
    const ctx = baseContext({
      goals: {
        active: 1,
        approaching: [{ id: 99, title: "Rapor teslim", dueDate: "2026-02-14", daysLeft: 0 }],
        needingFollowup: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.goalId).toBe(99);
  });

  test("skips today deadline during quiet hours", () => {
    setSystemTime(new Date("2026-02-14T23:30:00Z"));

    const ctx = baseContext({
      goals: {
        active: 1,
        approaching: [{ id: 1, title: "Gece deadline", dueDate: "2026-02-14", daysLeft: 0 }],
        needingFollowup: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(false);
  });
});

// ─── Goal follow-up ─────────────────────────────────────────────────

describe("goal follow-up", () => {
  test("triggers medium priority for overdue follow-up", () => {
    const ctx = baseContext({
      goals: {
        active: 2,
        approaching: [],
        needingFollowup: [
          { id: 7, title: "Spor programı", progress: 45, daysSinceFollowup: 5 },
        ],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.priority).toBe("medium");
    expect(decision.type).toBe("goal_followup");
    expect(decision.goalId).toBe(7);
    expect(decision.message).toContain("Spor programı");
    expect(decision.message).toContain("45%");
  });

  test("skips goal follow-up during quiet hours", () => {
    setSystemTime(new Date("2026-02-14T01:00:00Z"));

    const ctx = baseContext({
      goals: {
        active: 1,
        approaching: [],
        needingFollowup: [
          { id: 1, title: "Gece takibi", progress: 30, daysSinceFollowup: 3 },
        ],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.shouldNotify).toBe(false);
  });
});

// ─── Priority ordering ──────────────────────────────────────────────

describe("priority ordering", () => {
  test("overdue reminder takes priority over today deadline", () => {
    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [],
        overdue: [{ title: "Acil hatırlatma", triggerAt: "2026-02-14T10:00:00Z" }],
      },
      goals: {
        active: 1,
        approaching: [{ id: 1, title: "Deadline", dueDate: "2026-02-14", daysLeft: 0 }],
        needingFollowup: [],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.priority).toBe("urgent"); // overdue reminder, not today deadline
    expect(decision.type).toBe("nudge");
  });

  test("imminent reminder takes priority over goal follow-up", () => {
    const ctx = baseContext({
      reminders: {
        pending: 1,
        upcoming: [{ title: "Yaklaşan", triggerAt: "2026-02-14T14:02:00Z", minutesLeft: 2 }],
        overdue: [],
      },
      goals: {
        active: 1,
        approaching: [],
        needingFollowup: [
          { id: 1, title: "Takip", progress: 50, daysSinceFollowup: 5 },
        ],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.priority).toBe("high"); // imminent, not medium
    expect(decision.type).toBe("nudge");
  });

  test("today deadline takes priority over goal follow-up", () => {
    const ctx = baseContext({
      goals: {
        active: 2,
        approaching: [{ id: 10, title: "Bugün teslim", dueDate: "2026-02-14", daysLeft: 0 }],
        needingFollowup: [
          { id: 20, title: "Takip gerekli", progress: 40, daysSinceFollowup: 7 },
        ],
      },
    });
    const decision = makeQuickDecision(ctx);
    expect(decision.type).toBe("goal_followup");
    expect(decision.goalId).toBe(10); // today deadline goal, not followup goal
    expect(decision.priority).toBe("high"); // today deadline is high, not medium
  });
});

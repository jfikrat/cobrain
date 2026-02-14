/**
 * Unit tests for Cortex Layer 3: Actions (ActionExecutor)
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { ActionResult } from "./actions.ts";
import type { ActionPlan, ActionType } from "./reasoner.ts";

// We need a fresh ActionExecutor per test, so we re-instantiate the class.
// The module exports a singleton, but the class itself is not exported.
// We dynamically import to get a fresh module, or we replicate the class behavior.
// Simplest approach: import the module and create fresh instances via a factory.

// Since ActionExecutor class is not exported, we'll use a workaround:
// isolate each test by dynamically importing the module fresh.
// However, Bun's module cache makes this tricky.
// Instead, we test via the exported singleton but reset between tests,
// OR we extract the class for testing.

// Best approach: directly import and test. We'll create a helper that
// gives us a fresh executor by leveraging the module structure.

// The class is not exported, so we test through the singleton.
// For isolation, we'll track state carefully.

// Actually, let's just re-import with a loader trick or use the constructor pattern.
// Since we can't get the class, let's test with a pattern that creates fresh instances.

// --- Fresh instance factory via dynamic import with cache busting ---

async function createFreshExecutor() {
  // We can't easily bust Bun's module cache, so we'll build a minimal
  // ActionExecutor that mirrors the real one for unit testing purposes.
  // This is acceptable because we're testing the logic, not the import.

  // Instead, let's use a different approach: import the real module once
  // and test the singleton, being careful about state.

  // For proper isolation, let's just replicate the core logic in a test helper.
  // NO — that would test the replica, not the real code.

  // Final approach: We'll test the exported singleton and accept that
  // built-in handlers are pre-registered. We'll register custom handlers
  // on top and verify behavior. Stats won't be isolated but we can
  // track deltas.

  return null; // placeholder
}

// ── Approach: test the real singleton with careful state tracking ─────────

// We import the singleton and test against it.
// For compound actions and handler registration, the singleton works fine
// since we register unique action names per test.

import { actionExecutor } from "./actions.ts";
import { signalBus } from "./signal-bus.ts";

describe("ActionExecutor", () => {
  // ── 1. register() adds a handler ────────────────────────────────────

  test("register() adds a handler that appears in registeredActions()", () => {
    const testAction = "remember" as ActionType;
    const handler = async (params: Record<string, unknown>): Promise<ActionResult> => ({
      success: true,
      action: testAction,
      message: "remembered",
    });

    actionExecutor.register(testAction, handler);
    expect(actionExecutor.registeredActions()).toContain(testAction);
  });

  // ── 2. execute() with action "none" returns success ─────────────────

  test('execute() with action "none" returns success', async () => {
    const plan: ActionPlan = {
      action: "none",
      params: {},
      reasoning: "No action needed",
      urgency: "background",
    };

    const result = await actionExecutor.execute(plan);
    expect(result.success).toBe(true);
    expect(result.action).toBe("none");
    expect(result.message).toBe("No action needed");
  });

  // ── 3. execute() calls registered handler with correct params ───────

  test("execute() calls registered handler with correct params", async () => {
    const receivedParams: Record<string, unknown>[] = [];
    const testAction = "calculate_route" as ActionType;

    actionExecutor.register(testAction, async (params) => {
      receivedParams.push(params);
      return { success: true, action: testAction, message: "route calculated" };
    });

    const plan: ActionPlan = {
      action: testAction,
      params: { from: "Istanbul", to: "Ankara" },
      reasoning: "User asked for route",
      urgency: "immediate",
    };

    await actionExecutor.execute(plan);

    expect(receivedParams).toHaveLength(1);
    expect(receivedParams[0]).toEqual({ from: "Istanbul", to: "Ankara" });
  });

  // ── 4. execute() returns failure for unregistered action ────────────

  test("execute() returns failure for unregistered action", async () => {
    const plan: ActionPlan = {
      action: "check_whatsapp" as ActionType,
      params: {},
      reasoning: "test",
      urgency: "background",
    };

    // Make sure handler is NOT registered by checking first
    // (check_whatsapp might not be registered in the singleton)
    // We'll use a truly unknown action name by casting
    const unknownPlan: ActionPlan = {
      action: "nonexistent_action_xyz" as ActionType,
      params: {},
      reasoning: "test unknown",
      urgency: "background",
    };

    const result = await actionExecutor.execute(unknownPlan);
    expect(result.success).toBe(false);
    expect(result.action).toBe("nonexistent_action_xyz");
    expect(result.message).toContain("No handler registered");
  });

  // ── 5. Handler returning success produces correct ActionResult ──────

  test("handler returning success produces correct ActionResult", async () => {
    const testAction = "remember" as ActionType;

    actionExecutor.register(testAction, async (params) => ({
      success: true,
      action: testAction,
      message: "Memory saved",
      data: { key: params.key },
    }));

    const plan: ActionPlan = {
      action: testAction,
      params: { key: "user_preference", value: "dark_mode" },
      reasoning: "Save preference",
      urgency: "background",
    };

    const result = await actionExecutor.execute(plan);
    expect(result.success).toBe(true);
    expect(result.action).toBe("remember");
    expect(result.message).toBe("Memory saved");
    expect(result.data).toEqual({ key: "user_preference" });
  });

  // ── 6. Handler throwing error produces failure ActionResult ─────────

  test("handler throwing error produces failure ActionResult", async () => {
    const testAction = "send_message" as ActionType;

    actionExecutor.register(testAction, async () => {
      throw new Error("Telegram API timeout");
    });

    const plan: ActionPlan = {
      action: testAction,
      params: { chatId: 123, text: "hello" },
      reasoning: "Reply to user",
      urgency: "immediate",
    };

    const result = await actionExecutor.execute(plan);
    expect(result.success).toBe(false);
    expect(result.action).toBe("send_message");
    expect(result.message).toContain("Handler error");
    expect(result.message).toContain("Telegram API timeout");
  });

  // ── 7. Compound action executes sub-actions sequentially ────────────

  test("compound action executes sub-actions sequentially", async () => {
    const executionOrder: string[] = [];

    actionExecutor.register("remember" as ActionType, async (params) => {
      executionOrder.push(`remember:${params.key}`);
      return { success: true, action: "remember" as ActionType, message: "ok" };
    });

    actionExecutor.register("calculate_route" as ActionType, async (params) => {
      executionOrder.push(`route:${params.from}-${params.to}`);
      return { success: true, action: "calculate_route" as ActionType, message: "ok" };
    });

    const compoundPlan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Multiple actions needed",
      urgency: "immediate",
      followUp: [
        {
          action: "remember" as ActionType,
          params: { key: "step1" },
          reasoning: "first",
          urgency: "immediate",
        },
        {
          action: "calculate_route" as ActionType,
          params: { from: "A", to: "B" },
          reasoning: "second",
          urgency: "immediate",
        },
        {
          action: "remember" as ActionType,
          params: { key: "step3" },
          reasoning: "third",
          urgency: "immediate",
        },
      ],
    };

    const result = await actionExecutor.execute(compoundPlan);
    expect(result.success).toBe(true);
    expect(result.action).toBe("compound");
    expect(executionOrder).toEqual(["remember:step1", "route:A-B", "remember:step3"]);
    expect(result.message).toContain("3 sub-actions executed");
    expect(result.message).toContain("3 succeeded");
  });

  // ── 8. Compound action aborts on critical failure ───────────────────

  test("compound action aborts on critical failure (send_message)", async () => {
    // Register send_message to fail
    actionExecutor.register("send_message" as ActionType, async () => {
      throw new Error("Network error");
    });

    // Register remember to succeed and track calls
    const rememberCalls: string[] = [];
    actionExecutor.register("remember" as ActionType, async (params) => {
      rememberCalls.length = 0; // reset for this test
      rememberCalls.push(String(params.key));
      return { success: true, action: "remember" as ActionType, message: "ok" };
    });

    const compoundPlan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Should abort after send_message fails",
      urgency: "immediate",
      followUp: [
        {
          action: "remember" as ActionType,
          params: { key: "before_critical" },
          reasoning: "first",
          urgency: "immediate",
        },
        {
          action: "send_message" as ActionType,
          params: { chatId: 123, text: "hello" },
          reasoning: "critical — will fail",
          urgency: "immediate",
        },
        {
          action: "remember" as ActionType,
          params: { key: "after_critical_should_not_run" },
          reasoning: "should be skipped",
          urgency: "immediate",
        },
      ],
    };

    const result = await actionExecutor.execute(compoundPlan);
    expect(result.success).toBe(false);
    expect(result.action).toBe("compound");
    expect(result.message).toContain("Aborted");
    expect(result.message).toContain("critical failure");
    expect((result.data as any).aborted).toBe(true);
    // Only 2 sub-actions should have been attempted (remember + send_message)
    expect((result.data as any).results).toHaveLength(2);
  });

  // ── 8b. Compound action aborts on critical failure (send_whatsapp) ──

  test("compound action aborts on critical failure (send_whatsapp)", async () => {
    actionExecutor.register("send_whatsapp" as ActionType, async () => ({
      success: false,
      action: "send_whatsapp" as ActionType,
      message: "WhatsApp API error",
    }));

    const compoundPlan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Should abort after send_whatsapp fails",
      urgency: "immediate",
      followUp: [
        {
          action: "send_whatsapp" as ActionType,
          params: { to: "someone", text: "hi" },
          reasoning: "critical — will fail",
          urgency: "immediate",
        },
        {
          action: "none" as ActionType,
          params: {},
          reasoning: "should be skipped",
          urgency: "background",
        },
      ],
    };

    const result = await actionExecutor.execute(compoundPlan);
    expect(result.success).toBe(false);
    expect((result.data as any).aborted).toBe(true);
    expect((result.data as any).results).toHaveLength(1);
  });

  // ── 9. Compound action continues on non-critical failure ────────────

  test("compound action continues on non-critical failure", async () => {
    actionExecutor.register("calculate_route" as ActionType, async () => ({
      success: false,
      action: "calculate_route" as ActionType,
      message: "Route API down",
    }));

    const executionLog: string[] = [];

    actionExecutor.register("remember" as ActionType, async (params) => {
      executionLog.push(`remember:${params.key}`);
      return { success: true, action: "remember" as ActionType, message: "ok" };
    });

    const compoundPlan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Non-critical failure should not abort",
      urgency: "immediate",
      followUp: [
        {
          action: "remember" as ActionType,
          params: { key: "first" },
          reasoning: "step 1",
          urgency: "immediate",
        },
        {
          action: "calculate_route" as ActionType,
          params: { from: "X", to: "Y" },
          reasoning: "step 2 — will fail (non-critical)",
          urgency: "immediate",
        },
        {
          action: "remember" as ActionType,
          params: { key: "third" },
          reasoning: "step 3 — should still execute",
          urgency: "immediate",
        },
      ],
    };

    const result = await actionExecutor.execute(compoundPlan);
    // Overall success is false because one sub-action failed
    expect(result.success).toBe(false);
    expect(result.action).toBe("compound");
    // But it should NOT be aborted
    expect((result.data as any).aborted).toBe(false);
    // All 3 sub-actions should have been attempted
    expect((result.data as any).results).toHaveLength(3);
    // Execution log should show both remember calls ran
    expect(executionLog).toContain("remember:first");
    expect(executionLog).toContain("remember:third");
    expect(result.message).toContain("3 sub-actions executed");
    expect(result.message).toContain("2 succeeded");
  });

  // ── 10. stats() tracks executed and failed counts ───────────────────

  test("stats() tracks executed and failed counts", async () => {
    const statsBefore = actionExecutor.stats();
    const executedBefore = statsBefore.executed;
    const failedBefore = statsBefore.failed;

    // Execute a successful action
    await actionExecutor.execute({
      action: "none",
      params: {},
      reasoning: "stats test success",
      urgency: "background",
    });

    // Execute a failing action (unregistered)
    await actionExecutor.execute({
      action: "stats_test_unknown_action" as ActionType,
      params: {},
      reasoning: "stats test failure",
      urgency: "background",
    });

    const statsAfter = actionExecutor.stats();
    expect(statsAfter.executed).toBe(executedBefore + 2);
    expect(statsAfter.failed).toBe(failedBefore + 1);
    expect(statsAfter.successRate).toMatch(/^\d+%$/);
  });

  // ── 11. execute() with registered handler passes params correctly ───

  test("execute() passes all params from ActionPlan to handler", async () => {
    let capturedParams: Record<string, unknown> = {};
    const testAction = "check_whatsapp" as ActionType;

    actionExecutor.register(testAction, async (params) => {
      capturedParams = { ...params };
      return { success: true, action: testAction, message: "checked" };
    });

    const complexParams = {
      chatId: "group-123",
      limit: 10,
      since: "2026-02-14T00:00:00Z",
      filters: { unread: true, mentions: true },
      nested: { deep: { value: 42 } },
    };

    await actionExecutor.execute({
      action: testAction,
      params: complexParams,
      reasoning: "Check WhatsApp messages",
      urgency: "soon",
    });

    expect(capturedParams).toEqual(complexParams);
    expect(capturedParams.chatId).toBe("group-123");
    expect(capturedParams.limit).toBe(10);
    expect((capturedParams.filters as any).unread).toBe(true);
    expect((capturedParams.nested as any).deep.value).toBe(42);
  });

  // ── 12. registeredActions() lists all built-in + custom handlers ────

  test("registeredActions() includes built-in handlers", () => {
    const actions = actionExecutor.registeredActions();
    expect(actions).toContain("none");
    expect(actions).toContain("resolve_expectation");
    expect(actions).toContain("create_expectation");
  });

  // ── 13. Compound with empty followUp ────────────────────────────────

  test("compound action with empty followUp returns success", async () => {
    const plan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Empty compound",
      urgency: "background",
      followUp: [],
    };

    const result = await actionExecutor.execute(plan);
    expect(result.success).toBe(true);
    expect(result.action).toBe("compound");
    expect((result.data as any).results).toHaveLength(0);
  });

  // ── 14. Compound without followUp falls through to handler lookup ───

  test("compound without followUp array does not enter compound branch", async () => {
    // When action is "compound" but followUp is undefined,
    // the condition `plan.action === "compound" && plan.followUp` is false,
    // so it falls through to normal handler lookup.
    const plan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Compound without followUp",
      urgency: "background",
      // no followUp
    };

    const result = await actionExecutor.execute(plan);
    // "compound" has no registered handler, so it should fail
    expect(result.success).toBe(false);
    expect(result.message).toContain("No handler registered");
  });

  // ── 15. Handler error is caught and does not propagate ──────────────

  test("handler throwing non-Error value is handled gracefully", async () => {
    const testAction = "remember" as ActionType;

    actionExecutor.register(testAction, async () => {
      throw "string error thrown"; // non-Error throw
    });

    const result = await actionExecutor.execute({
      action: testAction,
      params: {},
      reasoning: "test non-Error throw",
      urgency: "background",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("Handler error");
    expect(result.message).toContain("string error thrown");
  });
});

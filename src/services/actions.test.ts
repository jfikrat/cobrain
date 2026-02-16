/**
 * Unit tests for Actions (ActionExecutor)
 */

import { test, expect, describe } from "bun:test";
import { actionExecutor, type ActionResult, type ActionPlan, type ActionType } from "./actions.ts";

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
    actionExecutor.register("send_message" as ActionType, async () => {
      throw new Error("Network error");
    });

    const rememberCalls: string[] = [];
    actionExecutor.register("remember" as ActionType, async (params) => {
      rememberCalls.length = 0;
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
    expect((result.data as any).results).toHaveLength(2);
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
    expect(result.success).toBe(false);
    expect(result.action).toBe("compound");
    expect((result.data as any).aborted).toBe(false);
    expect((result.data as any).results).toHaveLength(3);
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

    await actionExecutor.execute({
      action: "none",
      params: {},
      reasoning: "stats test success",
      urgency: "background",
    });

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

  // ── 11. registeredActions() includes built-in handlers ────

  test("registeredActions() includes built-in handlers", () => {
    const actions = actionExecutor.registeredActions();
    expect(actions).toContain("none");
    expect(actions).toContain("resolve_expectation");
    expect(actions).toContain("create_expectation");
  });

  // ── 12. Compound with empty followUp ────────────────────────────────

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

  // ── 13. Compound without followUp falls through to handler lookup ───

  test("compound without followUp array does not enter compound branch", async () => {
    const plan: ActionPlan = {
      action: "compound",
      params: {},
      reasoning: "Compound without followUp",
      urgency: "background",
    };

    const result = await actionExecutor.execute(plan);
    expect(result.success).toBe(false);
    expect(result.message).toContain("No handler registered");
  });

  // ── 14. Handler throwing non-Error value is handled gracefully ──────

  test("handler throwing non-Error value is handled gracefully", async () => {
    const testAction = "remember" as ActionType;

    actionExecutor.register(testAction, async () => {
      throw "string error thrown";
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

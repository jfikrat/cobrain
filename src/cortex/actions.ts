/**
 * Cortex Layer 3: Actions (Motor Korteks)
 *
 * Reasoner'dan gelen kararları execute eder.
 * Her aksiyon tipi için bir handler.
 */

import { type ActionPlan, type ActionType } from "./reasoner.ts";
import { expectations } from "./expectations.ts";
import { signalBus } from "./signal-bus.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ActionResult {
  success: boolean;
  action: ActionType;
  message?: string;
  data?: Record<string, unknown>;
}

type ActionHandler = (params: Record<string, unknown>) => Promise<ActionResult>;

// ── Action Executor ───────────────────────────────────────────────────────

class ActionExecutor {
  private handlers: Map<ActionType, ActionHandler> = new Map();
  private executedCount = 0;
  private failedCount = 0;

  constructor() {
    // Built-in handlers
    this.register("resolve_expectation", this.handleResolveExpectation.bind(this));
    this.register("create_expectation", this.handleCreateExpectation.bind(this));
    this.register("none", async () => ({ success: true, action: "none" as ActionType, message: "No action needed" }));
  }

  /**
   * Handler kaydet
   */
  register(action: ActionType, handler: ActionHandler): void {
    this.handlers.set(action, handler);
    console.log(`[Cortex:Actions] Handler registered: ${action}`);
  }

  /**
   * Aksiyon planını execute et
   */
  async execute(plan: ActionPlan): Promise<ActionResult> {
    this.executedCount++;

    console.log(`[Cortex:Actions] Executing: ${plan.action} urgency=${plan.urgency} "${plan.reasoning}"`);

    // Compound action — sıralı çalıştır
    if (plan.action === "compound" && plan.followUp) {
      const CRITICAL_ACTIONS: ActionType[] = ["send_message", "send_whatsapp"];
      const results: ActionResult[] = [];
      let aborted = false;

      for (const subPlan of plan.followUp) {
        const result = await this.execute(subPlan);
        results.push(result);
        if (!result.success) {
          if (CRITICAL_ACTIONS.includes(subPlan.action)) {
            console.error(`[Cortex:Actions] Critical sub-action failed: ${subPlan.action} — aborting compound`);
            aborted = true;
            break;
          }
          console.warn(`[Cortex:Actions] Compound sub-action failed: ${subPlan.action}, continuing`);
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const total = plan.followUp.length;
      const allSuccess = !aborted && results.every(r => r.success);
      return {
        success: allSuccess,
        action: "compound",
        message: aborted
          ? `Aborted after ${results.length}/${total} sub-actions (critical failure), ${succeeded} succeeded`
          : `${results.length} sub-actions executed, ${succeeded} succeeded`,
        data: { results, aborted },
      };
    }

    // Normal handler
    const handler = this.handlers.get(plan.action);
    if (!handler) {
      console.warn(`[Cortex:Actions] No handler for action: ${plan.action}`);
      this.failedCount++;
      return {
        success: false,
        action: plan.action,
        message: `No handler registered for action: ${plan.action}`,
      };
    }

    try {
      const result = await handler(plan.params);

      // Signal Bus'a bildir
      signalBus.push("system_event", "action_executed", {
        action: plan.action,
        success: result.success,
        reasoning: plan.reasoning,
      });

      return result;
    } catch (err) {
      this.failedCount++;
      console.error(`[Cortex:Actions] Handler error for ${plan.action}:`, err);
      return {
        success: false,
        action: plan.action,
        message: `Handler error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Built-in Handlers ─────────────────────────────────────────────────

  private async handleResolveExpectation(params: Record<string, unknown>): Promise<ActionResult> {
    const id = params.expectationId as string;
    const data = (params.data as Record<string, unknown>) || {};

    if (!id) {
      return { success: false, action: "resolve_expectation", message: "Missing expectationId" };
    }

    const resolved = await expectations.resolve(id, data);
    if (!resolved) {
      return { success: false, action: "resolve_expectation", message: `Expectation not found: ${id}` };
    }

    return {
      success: true,
      action: "resolve_expectation",
      message: `Resolved: ${resolved.context}`,
      data: { expectation: resolved },
    };
  }

  private async handleCreateExpectation(params: Record<string, unknown>): Promise<ActionResult> {
    const exp = await expectations.create({
      type: (params.type as string) as any || "custom",
      target: (params.target as string) || "",
      context: (params.context as string) || "",
      onResolved: (params.onResolved as string) || "",
      userId: (params.userId as number) || 0,
      timeout: (params.timeout as number) || undefined,
    });

    return {
      success: true,
      action: "create_expectation",
      message: `Created expectation: ${exp.context}`,
      data: { expectation: exp },
    };
  }

  /**
   * İstatistikler
   */
  stats(): { executed: number; failed: number; successRate: string } {
    const successRate = this.executedCount > 0
      ? `${Math.round(((this.executedCount - this.failedCount) / this.executedCount) * 100)}%`
      : "N/A";
    return { executed: this.executedCount, failed: this.failedCount, successRate };
  }

  /**
   * Kayıtlı handler'ları listele
   */
  registeredActions(): ActionType[] {
    return [...this.handlers.keys()];
  }
}

// Singleton
export const actionExecutor = new ActionExecutor();

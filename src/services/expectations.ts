/**
 * Expectations (Pending Actions)
 *
 * "What am I expecting?" state. When an action is taken (message sent,
 * research started), an expectation is recorded here.
 */

import { join } from "node:path";
import { config } from "../config.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export type ExpectationType =
  | "whatsapp_reply"      // Expecting a WhatsApp reply from someone
  | "research_result"     // Expecting research results
  | "reminder_followup"   // Follow-up after reminder
  | "location_arrival"    // Expecting arrival at a location
  | "user_confirmation"   // Expecting user confirmation
  | "scheduled_task"      // Scheduled task
  | "custom";             // Custom expectation

export interface PendingExpectation {
  /** Unique ID */
  id: string;
  /** Expectation type */
  type: ExpectationType;
  /** Target person or source (WhatsApp number, URL, etc.) */
  target: string;
  /** Context of the expectation — why we're waiting */
  context: string;
  /** What to do — when resolved */
  onResolved: string;
  /** Creation time */
  createdAt: number;
  /** Timeout (ms) — 0 = unlimited */
  timeout: number;
  /** Associated user */
  userId: number;
  /** Status */
  status: "pending" | "resolved" | "expired";
  /** Resolution time */
  resolvedAt?: number;
  /** Resolution data */
  resolvedData?: Record<string, unknown>;
}

// ── Expectations Manager ──────────────────────────────────────────────────

const DATA_FILE = join(process.cwd(), "data", "expectations.json");

class ExpectationsManager {
  private expectations: PendingExpectation[] = [];
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();

  /**
   * Load from file
   */
  async load(): Promise<void> {
    try {
      const file = Bun.file(DATA_FILE);
      if (await file.exists()) {
        const data = await file.json();
        this.expectations = data.expectations || [];
      }
    } catch (err) {
      console.warn("[Expectations] Failed to load:", err);
      this.expectations = [];
    }
    this.loaded = true;
    console.log(`[Expectations] Loaded ${this.pending().length} pending expectations`);
  }

  async save(): Promise<void> {
    this.saving = this.saving.then(() => this._doSave()).catch(() => {});
    return this.saving;
  }

  private async _doSave(): Promise<void> {
    try {
      const tmpPath = `${DATA_FILE}.tmp.${Date.now()}`;
      await Bun.write(tmpPath, JSON.stringify({ expectations: this.expectations }, null, 2));
      const fs = await import("node:fs/promises");
      await fs.rename(tmpPath, DATA_FILE);
    } catch (err) {
      console.warn("[Expectations] Failed to save:", err);
    }
  }

  /**
   * Create a new expectation
   */
  async create(params: {
    type: ExpectationType;
    target: string;
    context: string;
    onResolved: string;
    userId: number;
    timeout?: number; // ms, default 30 minutes
  }): Promise<PendingExpectation> {
    const expectation: PendingExpectation = {
      id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: params.type,
      target: params.target,
      context: params.context,
      onResolved: params.onResolved,
      userId: params.userId,
      timeout: params.timeout ?? config.CORTEX_EXPECTATION_TIMEOUT_MS,
      createdAt: Date.now(),
      status: "pending",
    };

    this.expectations.push(expectation);
    await this.save();

    console.log(`[Expectations] Created: ${expectation.type} target=${expectation.target} "${expectation.context}"`);

    return expectation;
  }

  /**
   * Resolve an expectation
   */
  async resolve(id: string, data: Record<string, unknown> = {}): Promise<PendingExpectation | null> {
    const exp = this.expectations.find(e => e.id === id && e.status === "pending");
    if (!exp) return null;

    exp.status = "resolved";
    exp.resolvedAt = Date.now();
    exp.resolvedData = data;
    await this.save();

    const duration = Math.round((exp.resolvedAt - exp.createdAt) / 1000);
    console.log(`[Expectations] Resolved: ${exp.type} target=${exp.target} (${duration}s)`);

    return exp;
  }

  /**
   * Clean up expired expectations
   */
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
      console.log(`[Expectations] ${expired.length} expectations expired`);
      this.save(); // async, fire-and-forget
    }

    return expired;
  }

  /**
   * Pending expectations
   */
  pending(): PendingExpectation[] {
    return this.expectations.filter(e => e.status === "pending");
  }

  /**
   * Pending expectations for a specific user
   */
  pendingForUser(userId: number): PendingExpectation[] {
    return this.expectations.filter(e => e.status === "pending" && e.userId === userId);
  }

  /**
   * All expectations (debug)
   */
  all(): PendingExpectation[] {
    return [...this.expectations];
  }

  /**
   * Clean up old resolved/expired entries (older than 7 days)
   */
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
      console.log(`[Expectations] Pruned ${removed} old entries`);
    }
    return removed;
  }
}

// Singleton
export const expectations = new ExpectationsManager();

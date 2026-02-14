/**
 * Simple Circuit Breaker
 *
 * States: CLOSED (normal) -> OPEN (fast-fail) -> HALF_OPEN (probe)
 *
 * - CLOSED: calls pass through normally, failures tracked
 * - After maxFailures consecutive failures -> OPEN
 * - OPEN: immediately rejects without calling the function
 * - After cooldownMs -> HALF_OPEN: allows ONE probe call
 * - If probe succeeds -> CLOSED, if fails -> OPEN again
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /** Name for logging */
  name: string;
  /** Consecutive failures before opening circuit (default: 3) */
  maxFailures?: number;
  /** How long to stay OPEN before allowing a probe, in ms (default: 60_000) */
  cooldownMs?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  lastFailure: number | null;
  totalTrips: number;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private lastFailureTime: number | null = null;
  private totalTrips = 0;

  private readonly name: string;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;

  constructor(config: CircuitBreakerConfig) {
    this.name = config.name;
    this.maxFailures = config.maxFailures ?? 3;
    this.cooldownMs = config.cooldownMs ?? 60_000;
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if the circuit is OPEN and cooldown hasn't elapsed.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should transition from OPEN -> HALF_OPEN
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.lastFailureTime ?? 0);
      if (elapsed >= this.cooldownMs) {
        this.transition("HALF_OPEN");
      } else {
        throw new CircuitOpenError(
          `[CircuitBreaker:${this.name}] Circuit is OPEN — fast-failing (${Math.round((this.cooldownMs - elapsed) / 1000)}s until probe)`,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /**
   * Check if the circuit is currently open (rejecting calls).
   */
  isOpen(): boolean {
    if (this.state !== "OPEN") return false;
    // Check if cooldown has elapsed — would transition to HALF_OPEN on next execute
    const elapsed = Date.now() - (this.lastFailureTime ?? 0);
    return elapsed < this.cooldownMs;
  }

  /**
   * Get current stats.
   */
  stats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailureTime,
      totalTrips: this.totalTrips,
    };
  }

  private onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.transition("CLOSED");
    }
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Probe failed — back to OPEN
      this.transition("OPEN");
    } else if (this.failures >= this.maxFailures) {
      this.transition("OPEN");
    }
  }

  private transition(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;

    if (newState === "OPEN") {
      this.totalTrips++;
      console.log(
        `[CircuitBreaker:${this.name}] ${oldState} \u2192 OPEN (${this.failures} consecutive failures)`,
      );
    } else if (newState === "HALF_OPEN") {
      console.log(
        `[CircuitBreaker:${this.name}] ${oldState} \u2192 HALF_OPEN (cooldown elapsed, probing)`,
      );
    } else if (newState === "CLOSED") {
      console.log(
        `[CircuitBreaker:${this.name}] ${oldState} \u2192 CLOSED (probe succeeded)`,
      );
      this.failures = 0;
    }
  }
}

/**
 * Error thrown when circuit is OPEN and rejecting calls.
 */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

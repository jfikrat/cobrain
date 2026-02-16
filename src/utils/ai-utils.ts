/**
 * Shared AI utilities
 */

import { CircuitBreaker } from "./circuit-breaker.ts";

/**
 * Race a promise against a timeout. Clears the timer when the promise
 * settles first so we don't leak setTimeout handles.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

/**
 * Shared Gemini API circuit breaker.
 * Single instance because they hit the same Gemini endpoint.
 *
 * Opens after 3 consecutive failures, cools down for 60s, then probes.
 */
export const geminiBreaker = new CircuitBreaker({
  name: "Gemini",
  maxFailures: 3,
  cooldownMs: 60_000,
});

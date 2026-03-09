/**
 * Interaction Tracker
 * Records user interaction timestamps for session state.
 */

import { updateSessionState } from "./session-state.ts";

/**
 * Record user interaction — update lastInteractionTime in session state.
 * Called when user sends a message via Telegram.
 */
export function recordInteraction(userId: number): void {
  updateSessionState(userId, { lastInteractionTime: Date.now() });
}

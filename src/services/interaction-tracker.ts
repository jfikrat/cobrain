/**
 * Interaction Tracker — barrel re-export for telegram.ts compatibility.
 * Consolidates user interaction tracking functions.
 */

import { updateSessionState } from "./session-state.ts";

/**
 * Record user interaction — update lastInteractionTime in session state.
 * Called when user sends a message via Telegram.
 */
export function recordInteraction(userId: number): void {
  updateSessionState(userId, { lastInteractionTime: Date.now() });
}

/**
 * Record user activity for pattern learning.
 * No-op: activity-patterns service removed.
 */
export async function recordUserActivity(_userId: number): Promise<void> {
  // activity-patterns.ts removed
}

/**
 * Extract mood from message.
 * No-op: mood-extraction service removed.
 */
export async function extractMoodFromMessage(
  _userId: number,
  _userMessage: string,
  _aiResponse: string
): Promise<void> {
  // mood-extraction.ts removed
}

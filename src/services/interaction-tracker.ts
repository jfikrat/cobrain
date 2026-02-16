/**
 * Interaction Tracker — barrel re-export for telegram.ts compatibility.
 * Consolidates user interaction tracking functions.
 */

export { extractMoodFromMessage } from "./mood-extraction.ts";

import { updateSessionState } from "./session-state.ts";
import { getActivityPatternService } from "./activity-patterns.ts";

/**
 * Record user interaction — update lastInteractionTime in session state.
 * Called when user sends a message via Telegram.
 */
export function recordInteraction(userId: number): void {
  updateSessionState(userId, { lastInteractionTime: Date.now() });
}

/**
 * Record user activity for pattern learning.
 * Called alongside recordInteraction to build activity heatmaps.
 */
export async function recordUserActivity(userId: number): Promise<void> {
  try {
    const patternService = await getActivityPatternService(userId);
    patternService.recordInteraction();
  } catch (error) {
    console.warn("[InteractionTracker] Activity recording failed:", error);
  }
}

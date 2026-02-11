/**
 * Router-lite — Rule-based model cascade (no LLM call)
 * Phase 1: Complexity scoring → fast / default / deep
 */

import { config } from "../config.ts";
import type { RouteDecision } from "../types/brain-events.ts";

/**
 * Deterministic complexity scoring to pick the right model tier.
 *
 * FF_ROUTER_LITE=false → result is logged but NOT applied (shadow mode)
 * FF_ROUTER_LITE=true  → result overrides the model selection
 */
export function routeLite(input: {
  text: string;
  hasImage: boolean;
  channel: string;
  historyLength?: number;
}): RouteDecision {
  // Deterministic commands → no model needed
  if (input.text.startsWith("/")) {
    return { model: "none", level: "fast", reason: "deterministic_command" };
  }

  // Complexity scoring
  let score = 0;

  // Image analysis is expensive
  if (input.hasImage) score += 3;

  // Message length
  if (input.text.length > 500) score += 2;
  else if (input.text.length > 200) score += 1;

  // Complex task keywords (Turkish + English)
  if (
    /araştır|analiz|karşılaştır|plan|tasarla|debug|refactor/i.test(input.text)
  )
    score += 2;

  if (/kod yaz|implement|geliştir|oluştur/i.test(input.text)) score += 2;

  if (/dosya|file|read|write|edit/i.test(input.text)) score += 1;

  // Long conversation context
  if ((input.historyLength ?? 0) > 15) score += 1;

  // Route decision
  if (score <= 1) {
    return {
      model: config.AGENT_MODEL_FAST,
      level: "fast",
      reason: `simple_query (score=${score})`,
    };
  }
  if (score <= 4) {
    return {
      model: config.AGENT_MODEL_DEFAULT,
      level: "default",
      reason: `moderate_query (score=${score})`,
    };
  }
  return {
    model: config.AGENT_MODEL,
    level: "deep",
    reason: `complex_query (score=${score})`,
  };
}

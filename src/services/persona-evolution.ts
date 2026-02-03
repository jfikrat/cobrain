/**
 * Persona Evolution Service
 * Detects patterns and triggers persona evolution
 * Cobrain v0.3
 */

import type { Database } from "bun:sqlite";
import { getPersonaService } from "./persona.ts";
import type { EvolutionTrigger, EvolutionTriggerType, PersonaSuggestion } from "../types/persona.ts";

interface FeedbackPattern {
  pattern: RegExp;
  field: string;
  adjustment: number | string;
  reason: string;
}

// Feedback patterns for automatic detection
const FEEDBACK_PATTERNS: FeedbackPattern[] = [
  // Verbosity adjustments
  { pattern: /daha kısa yaz/i, field: "voice.verbosity", adjustment: -0.2, reason: "Kullanıcı daha kısa cevaplar istiyor" },
  { pattern: /çok kısa/i, field: "voice.verbosity", adjustment: 0.2, reason: "Kullanıcı daha detaylı cevaplar istiyor" },
  { pattern: /daha detaylı/i, field: "voice.verbosity", adjustment: 0.2, reason: "Kullanıcı daha detaylı cevaplar istiyor" },

  // Formality adjustments
  { pattern: /çok resmi/i, field: "voice.formality", adjustment: -0.2, reason: "Kullanıcı daha samimi ton istiyor" },
  { pattern: /daha resmi/i, field: "voice.formality", adjustment: 0.2, reason: "Kullanıcı daha resmi ton istiyor" },

  // Emoji usage
  { pattern: /emoji kullan/i, field: "voice.emojiUsage", adjustment: "minimal", reason: "Kullanıcı emoji istiyor" },
  { pattern: /emoji kullanma/i, field: "voice.emojiUsage", adjustment: "none", reason: "Kullanıcı emoji istemiyor" },

  // Proactivity
  { pattern: /daha proaktif/i, field: "behavior.proactivity", adjustment: 0.2, reason: "Kullanıcı daha proaktif davranış istiyor" },
  { pattern: /sorma.*direkt yap/i, field: "behavior.clarificationThreshold", adjustment: -0.2, reason: "Kullanıcı daha az soru sorulmasını istiyor" },
];

/**
 * Analyze message for feedback patterns
 */
export function detectFeedbackTriggers(message: string): PersonaSuggestion[] {
  const suggestions: PersonaSuggestion[] = [];

  for (const pattern of FEEDBACK_PATTERNS) {
    if (pattern.pattern.test(message)) {
      suggestions.push({
        field: pattern.field,
        currentValue: null, // Will be filled by caller
        suggestedValue: pattern.adjustment,
        reason: pattern.reason,
        confidence: 0.8,
      });
    }
  }

  return suggestions;
}

/**
 * Record evolution trigger for later processing
 */
export async function recordEvolutionTrigger(
  userId: number,
  triggerType: EvolutionTriggerType,
  triggerData: Record<string, unknown>
): Promise<void> {
  const service = await getPersonaService(userId);
  // PersonaService'e trigger kaydetme metodu eklenecek
  // Şimdilik sadece loglayalım
  console.log(`[Evolution] Trigger recorded for user ${userId}: ${triggerType}`, triggerData);
}

/**
 * Check milestone triggers
 */
export async function checkMilestoneTriggers(
  userId: number,
  messageCount: number
): Promise<void> {
  const milestones = [100, 500, 1000, 5000];

  for (const milestone of milestones) {
    if (messageCount === milestone) {
      console.log(`[Evolution] Milestone reached for user ${userId}: ${milestone} messages`);

      // Create snapshot at milestone
      const service = await getPersonaService(userId);
      await service.createSnapshot(`${milestone}. mesaj`, `Otomatik milestone snapshot`);

      await recordEvolutionTrigger(userId, "milestone", {
        milestone,
        messageCount,
      });
    }
  }
}

/**
 * Process pending evolution triggers
 * This would be called periodically by a background job
 */
export async function processEvolutionTriggers(userId: number): Promise<PersonaSuggestion[]> {
  // For now, this is a placeholder
  // In the future, this could:
  // 1. Aggregate recent feedback triggers
  // 2. Detect patterns from message history
  // 3. Use Cerebras to analyze and suggest changes

  const suggestions: PersonaSuggestion[] = [];

  // TODO: Implement pattern detection
  // - Analyze time-of-day patterns
  // - Detect preferred response lengths
  // - Track topic interests

  return suggestions;
}

/**
 * Apply auto-approved evolution suggestion
 */
export async function applyEvolutionSuggestion(
  userId: number,
  suggestion: PersonaSuggestion
): Promise<boolean> {
  try {
    const service = await getPersonaService(userId);
    const result = await service.updateField(
      suggestion.field,
      suggestion.suggestedValue,
      suggestion.reason,
      "system"
    );

    if (result.success) {
      console.log(`[Evolution] Auto-applied suggestion for user ${userId}: ${suggestion.field}`);
      return true;
    }

    // If requires approval, log it
    if (result.requiresApproval) {
      console.log(`[Evolution] Suggestion requires approval: ${suggestion.field}`);
    }

    return false;
  } catch (error) {
    console.error(`[Evolution] Failed to apply suggestion:`, error);
    return false;
  }
}

/**
 * Mood Extraction — infer mood from user messages via Haiku
 * Extracted from living-assistant.ts for use in brain-loop and telegram channel.
 */

import { getMoodTrackingService, type MoodType } from "./mood-tracking.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20250121";

/**
 * Extract mood from user message using Haiku AI.
 * Records to mood-tracking service if confidence >= 0.5.
 * Silently fails — mood extraction is optional.
 */
export async function extractMoodFromMessage(
  userId: number,
  message: string,
  _response: string
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  // Only analyze longer messages that might contain mood signals
  if (message.length < 10) return;

  try {
    const result = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 100,
        system: `Mesajdan ruh hali çıkar. SADECE şu formatta JSON döndür:
{"mood": "great|good|neutral|low|bad", "energy": 1-5, "confidence": 0.0-1.0, "triggers": ["neden1"]}
Eğer mood belirlenemiyorsa: {"mood": null}`,
        messages: [
          {
            role: "user",
            content: `Kullanıcı mesajı: "${message.slice(0, 500)}"`,
          },
        ],
      }),
    });

    if (!result.ok) return;

    const data = (await result.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content.find((c) => c.type === "text")?.text || "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          mood: MoodType | null;
          energy?: number;
          confidence?: number;
          triggers?: string[];
        };

        if (parsed.mood && parsed.confidence && parsed.confidence >= 0.5) {
          const moodService = await getMoodTrackingService(userId);
          moodService.recordMood({
            mood: parsed.mood,
            energy: parsed.energy ?? 3,
            context: message.slice(0, 100),
            triggers: parsed.triggers ?? [],
            source: "inferred",
            confidence: parsed.confidence,
          });

          console.log(`[BrainLoop:Mood] Inferred mood: ${parsed.mood} (confidence: ${parsed.confidence})`);
        }
      }
    } catch {
      // Parsing failed, ignore
    }
  } catch (error) {
    console.warn("[BrainLoop:Mood] Mood extraction failed:", error);
  }
}

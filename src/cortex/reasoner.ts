/**
 * Cortex Layer 2: Reasoner (Korteks)
 *
 * Salience Filter'dan geçen önemli sinyalleri işler.
 * Sonnet ile karar verir: ne yapılmalı?
 *
 * Input: signal + salience result + context
 * Output: action plan (ne yapılacak, hangi araçlarla)
 */

import Anthropic from "@anthropic-ai/sdk";
import { type Signal } from "./signal-bus.ts";
import { type SalienceResult } from "./salience.ts";
import { expectations } from "./expectations.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export type ActionType =
  | "send_message"        // Telegram'dan kullanıcıya mesaj gönder
  | "send_whatsapp"       // WhatsApp'tan mesaj gönder
  | "calculate_route"     // Yol hesapla
  | "remember"            // Hafızaya kaydet
  | "create_expectation"  // Yeni beklenti oluştur
  | "resolve_expectation" // Beklentiyi çöz
  | "search_web"          // Web'de ara
  | "check_whatsapp"      // WhatsApp mesajlarını kontrol et
  | "schedule_reminder"   // Hatırlatıcı kur
  | "compound"            // Birden fazla aksiyon (sıralı)
  | "none";               // Aksiyon gerekmiyor

export interface ActionPlan {
  /** Birincil aksiyon */
  action: ActionType;
  /** Aksiyon parametreleri */
  params: Record<string, unknown>;
  /** Açıklama — neden bu karar verildi */
  reasoning: string;
  /** Opsiyonel: ek aksiyonlar (compound durumunda) */
  followUp?: ActionPlan[];
  /** Aciliyet: immediate | soon | background */
  urgency: "immediate" | "soon" | "background";
}

export interface ReasonerConfig {
  model: string;
  maxTokens: number;
}

// ── Default Config ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ReasonerConfig = {
  model: "claude-sonnet-4-20250514",
  maxTokens: 500,
};

// ── Reasoner ──────────────────────────────────────────────────────────────

class Reasoner {
  private client: Anthropic;
  private config: ReasonerConfig;
  private decisionsCount = 0;

  constructor(reasonerConfig: ReasonerConfig = DEFAULT_CONFIG) {
    this.client = new Anthropic(); // ANTHROPIC_API_KEY env'den otomatik alınır
    this.config = reasonerConfig;
  }

  /**
   * Sinyal hakkında karar ver
   */
  async decide(
    signal: Signal,
    salience: SalienceResult,
    userContext: string = ""
  ): Promise<ActionPlan> {
    this.decisionsCount++;

    // 1. Hızlı kural tabanlı karar
    const quickDecision = this.quickDecide(signal, salience);
    if (quickDecision) return quickDecision;

    // 2. Sonnet ile karar
    try {
      return await this.decideWithSonnet(signal, salience, userContext);
    } catch (err) {
      console.warn("[Cortex:Reasoner] Decision failed:", err);
      return {
        action: "none",
        params: {},
        reasoning: "AI decision failed, skipping",
        urgency: "background",
      };
    }
  }

  /**
   * Hızlı kural tabanlı kararlar
   */
  private quickDecide(signal: Signal, salience: SalienceResult): ActionPlan | null {
    // Beklenti eşleşmesi — resolve et ve bildir
    if (salience.matchedExpectationId) {
      const exp = expectations.pending().find(e => e.id === salience.matchedExpectationId);
      if (exp) {
        return {
          action: "compound",
          params: {},
          reasoning: `Beklenti eşleşti: "${exp.context}"`,
          urgency: "immediate",
          followUp: [
            {
              action: "resolve_expectation",
              params: {
                expectationId: exp.id,
                data: signal.data,
              },
              reasoning: "Beklentiyi çöz",
              urgency: "immediate",
            },
            {
              action: "send_message",
              params: {
                text: `${exp.context} — cevap geldi: ${JSON.stringify(signal.data).slice(0, 200)}`,
                onResolved: exp.onResolved,
              },
              reasoning: exp.onResolved,
              urgency: "immediate",
            },
          ],
        };
      }
    }

    // Expectation timeout — kullanıcıya bildir
    if (signal.source === "expectation_timeout") {
      return {
        action: "send_message",
        params: {
          text: `Beklenti zaman aşımına uğradı: ${signal.data.context}`,
          expectationId: signal.data.expectationId,
        },
        reasoning: "Expectation expired, notify user",
        urgency: "soon",
      };
    }

    return null; // Sonnet'e sor
  }

  /**
   * Sonnet ile detaylı karar
   */
  private async decideWithSonnet(
    signal: Signal,
    salience: SalienceResult,
    userContext: string
  ): Promise<ActionPlan> {
    const pendingExps = expectations.pending();

    const prompt = `Sen Cobrain AI asistanının karar mekanizmasısın. Gelen sinyal hakkında ne yapılması gerektiğine karar ver.

SINYAL:
- Kaynak: ${signal.source}
- Tip: ${signal.type}
- Veri: ${JSON.stringify(signal.data).slice(0, 500)}
- Kişi: ${signal.contactId || "yok"}
- Önem skoru: ${salience.score}
- Önem nedeni: ${salience.reason}

BEKLEYEN BEKLENTILER:
${pendingExps.map(e => `- [${e.type}] ${e.target}: "${e.context}" → "${e.onResolved}"`).join("\n") || "- Yok"}

KULLANICI BAĞLAMI:
${userContext || "Bilgi yok"}

MEVCUT AKSIYON TIPLERI:
- send_message: Telegram'dan kullanıcıya bildir
- send_whatsapp: WhatsApp mesaj gönder
- calculate_route: Yol/mesafe hesapla
- remember: Hafızaya kaydet
- create_expectation: Yeni beklenti oluştur
- resolve_expectation: Mevcut beklentiyi çöz
- check_whatsapp: WhatsApp mesajlarını kontrol et
- schedule_reminder: Hatırlatıcı kur
- none: Aksiyon gerekmiyor

CEVAP (sadece JSON):
{"action": "...", "params": {...}, "reasoning": "kısa açıklama", "urgency": "immediate|soon|background"}`;

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response");

      const plan = JSON.parse(jsonMatch[0]) as ActionPlan;
      console.log(`[Cortex:Reasoner] ${signal.source}/${signal.type} → action=${plan.action} urgency=${plan.urgency} "${plan.reasoning}"`);

      return plan;
    } catch {
      console.warn("[Cortex:Reasoner] Failed to parse Sonnet response:", text.slice(0, 100));
      return {
        action: "none",
        params: {},
        reasoning: "Could not determine action",
        urgency: "background",
      };
    }
  }

  /**
   * İstatistikler
   */
  stats(): { decisions: number } {
    return { decisions: this.decisionsCount };
  }
}

// Singleton
export const reasoner = new Reasoner();

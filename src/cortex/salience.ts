/**
 * Cortex Layer 1: Salience Filter (Limbik Sistem)
 *
 * Her sinyale 0-1 arası önem skoru verir. Haiku ile hızlı değerlendirme.
 * İnsandaki dopamin = salience signal.
 *
 * Input: signal + pending expectations + user context + zaman
 * Output: salience skoru (0-1) + neden
 *
 * Eşik: 0.3 altını düşür, üstünü Reasoner'a gönder
 */

import Anthropic from "@anthropic-ai/sdk";
import { signalBus, type Signal } from "./signal-bus.ts";
import { expectations } from "./expectations.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SalienceResult {
  /** 0-1 arası önem skoru */
  score: number;
  /** Neden bu skor verildi (kısa açıklama) */
  reason: string;
  /** Eşleşen beklenti varsa ID'si */
  matchedExpectationId?: string;
  /** Önerilen aksiyon tipi */
  suggestedAction?: "notify" | "act" | "wait" | "ignore";
}

export interface SalienceConfig {
  /** Minimum eşik — altındakiler düşürülür */
  threshold: number;
  /** Haiku model */
  model: string;
  /** Max token for response */
  maxTokens: number;
}

// ── Default Config ────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SalienceConfig = {
  threshold: 0.3,
  model: "claude-haiku-4-20250514",
  maxTokens: 200,
};

// ── Salience Filter ───────────────────────────────────────────────────────

class SalienceFilter {
  private client: Anthropic;
  private config: SalienceConfig;
  private processedCount = 0;
  private passedCount = 0;

  constructor(salienceConfig: SalienceConfig = DEFAULT_CONFIG) {
    this.client = new Anthropic(); // ANTHROPIC_API_KEY env'den otomatik alınır
    this.config = salienceConfig;
  }

  /**
   * Sinyalin önemini değerlendir
   */
  async evaluate(signal: Signal, userContext: string = ""): Promise<SalienceResult> {
    this.processedCount++;

    // 1. Hızlı kural tabanlı kontrol (Haiku'ya sormadan)
    const quickResult = this.quickCheck(signal);
    if (quickResult) {
      if (quickResult.score >= this.config.threshold) this.passedCount++;
      return quickResult;
    }

    // 2. Eşleşen beklentiler
    const matchedExpectations = expectations.matchSignal(signal);
    const hasExpectationMatch = matchedExpectations.length > 0;

    // Beklenti eşleşmesi varsa skoru yükselt — Haiku'ya sormaya bile gerek yok
    if (hasExpectationMatch) {
      this.passedCount++;
      const exp = matchedExpectations[0];
      return {
        score: 0.9,
        reason: `Beklenti eşleşmesi: "${exp.context}"`,
        matchedExpectationId: exp.id,
        suggestedAction: "act",
      };
    }

    // 3. Haiku ile değerlendirme
    try {
      return await this.evaluateWithHaiku(signal, userContext, matchedExpectations);
    } catch (err) {
      console.warn("[Cortex:Salience] Haiku evaluation failed:", err);
      // Fallback: orta skor ver, Reasoner karar versin
      return {
        score: 0.5,
        reason: "Haiku evaluation failed, default score",
        suggestedAction: "wait",
      };
    }
  }

  /**
   * Hızlı kural tabanlı kontrol — bazı sinyaller Haiku'ya sorulmadan değerlendirilebilir
   */
  private quickCheck(signal: Signal): SalienceResult | null {
    // Sistem eventleri genelde düşük öncelik
    if (signal.source === "system_event" && signal.type === "bus_started") {
      return { score: 0.1, reason: "System boot event", suggestedAction: "ignore" };
    }

    // Time tick'ler düşük — ama beklenti kontrolü için kullanılır
    if (signal.source === "time_tick") {
      return { score: 0.1, reason: "Periodic time tick", suggestedAction: "ignore" };
    }

    // Kullanıcı mesajı — zaten chat pipeline'dan işleniyor, Cortex'in tekrar işlemesine gerek yok
    // Sadece logla, beklenti eşleşmesi kontrolü yukarıda yapıldı
    if (signal.source === "user_message") {
      return { score: 0.1, reason: "User message — handled by chat pipeline", suggestedAction: "ignore" };
    }

    // Expectation timeout her zaman önemli
    if (signal.source === "expectation_timeout") {
      return { score: 0.7, reason: "Expectation timed out", suggestedAction: "notify" };
    }

    return null; // Haiku'ya sor
  }

  /**
   * Haiku ile detaylı değerlendirme
   */
  private async evaluateWithHaiku(
    signal: Signal,
    userContext: string,
    matchedExpectations: unknown[]
  ): Promise<SalienceResult> {
    const pendingExps = expectations.pending();

    const prompt = `Sen bir sinyal önem değerlendirme sistemisin. Verilen sinyalin kullanıcı için ne kadar önemli olduğunu 0-1 arası skorla.

SINYAL:
- Kaynak: ${signal.source}
- Tip: ${signal.type}
- Veri: ${JSON.stringify(signal.data).slice(0, 300)}
- Kişi: ${signal.contactId || "yok"}
- Zaman: ${new Date(signal.timestamp).toLocaleTimeString("tr-TR")}

BEKLEYEN BEKLENTILER (${pendingExps.length} adet):
${pendingExps.map(e => `- [${e.type}] ${e.target}: "${e.context}" (${Math.round((Date.now() - e.createdAt) / 60000)}dk önce)`).join("\n") || "- Yok"}

KULLANICI BAĞLAMI:
${userContext || "Bilgi yok"}

CEVAP FORMATI (sadece JSON):
{"score": 0.X, "reason": "kısa açıklama", "suggestedAction": "notify|act|wait|ignore"}`;

    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";

    try {
      // JSON parse et
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response");

      const result = JSON.parse(jsonMatch[0]) as SalienceResult;
      result.score = Math.max(0, Math.min(1, result.score)); // Clamp 0-1

      if (result.score >= this.config.threshold) this.passedCount++;

      console.log(`[Cortex:Salience] ${signal.source}/${signal.type} → score=${result.score} reason="${result.reason}" action=${result.suggestedAction}`);

      return result;
    } catch {
      console.warn("[Cortex:Salience] Failed to parse Haiku response:", text.slice(0, 100));
      return { score: 0.5, reason: "Parse failed", suggestedAction: "wait" };
    }
  }

  /**
   * İstatistikler
   */
  stats(): { processed: number; passed: number; passRate: string } {
    const passRate = this.processedCount > 0
      ? `${Math.round((this.passedCount / this.processedCount) * 100)}%`
      : "N/A";
    return { processed: this.processedCount, passed: this.passedCount, passRate };
  }

  /**
   * Eşik değerini güncelle
   */
  setThreshold(threshold: number): void {
    this.config.threshold = Math.max(0, Math.min(1, threshold));
    console.log(`[Cortex:Salience] Threshold updated to ${this.config.threshold}`);
  }

  getThreshold(): number {
    return this.config.threshold;
  }
}

// Singleton
export const salienceFilter = new SalienceFilter();

/**
 * Cortex — Ana Orkestratör
 *
 * Signal Bus → Salience Filter → Reasoner → Actions
 *
 * Tüm katmanları birleştirir, sinyalleri pipeline'dan geçirir.
 * Start/stop lifecycle yönetimi.
 */

import { signalBus, type Signal } from "./signal-bus.ts";
import { expectations } from "./expectations.ts";
import { salienceFilter } from "./salience.ts";
import { reasoner } from "./reasoner.ts";
import { actionExecutor, type ActionResult } from "./actions.ts";

// Re-export everything
export { signalBus, expectations, salienceFilter, reasoner, actionExecutor };
export type { Signal } from "./signal-bus.ts";
export type { PendingExpectation } from "./expectations.ts";
export type { SalienceResult } from "./salience.ts";
export type { ActionPlan } from "./reasoner.ts";
export type { ActionResult } from "./actions.ts";

// ── Cortex Pipeline ───────────────────────────────────────────────────────

interface CortexConfig {
  /** Kullanıcı bağlamı sağlayıcı — her sinyal değerlendirmesinde çağrılır */
  userContextProvider?: (userId?: number) => Promise<string>;
  /** Aksiyon sonrası callback — execute edilen aksiyonlar buraya düşer */
  onActionExecuted?: (signal: Signal, result: ActionResult) => void;
  /** Hata callback */
  onError?: (error: Error, signal: Signal) => void;
}

class Cortex {
  private running = false;
  private config: CortexConfig = {};
  private processingQueue: Signal[] = [];
  private isProcessing = false;
  private expiryInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Cortex'i başlat
   */
  async start(config: CortexConfig = {}): Promise<void> {
    if (this.running) return;

    this.config = config;

    // Expectations'ı yükle
    await expectations.load();

    // Signal Bus'ı başlat
    signalBus.start();

    // Signal Bus'a abone ol — her sinyal pipeline'dan geçecek
    signalBus.on("signal", (signal: Signal) => {
      this.enqueue(signal);
    });

    // Periyodik beklenti temizliği (her 60 saniye)
    this.expiryInterval = setInterval(() => {
      expectations.cleanExpired();
    }, 60_000);

    this.running = true;
    console.log("[Cortex] Started — Signal Bus → Salience → Reasoner → Actions pipeline active");
  }

  /**
   * Cortex'i durdur
   */
  stop(): void {
    if (!this.running) return;

    signalBus.stop();
    if (this.expiryInterval) {
      clearInterval(this.expiryInterval);
      this.expiryInterval = null;
    }

    this.running = false;
    console.log("[Cortex] Stopped");
  }

  /**
   * Sinyal kuyruğa ekle — sıralı işleme
   */
  private enqueue(signal: Signal): void {
    // system_event sinyallerini pipeline'a sokma (sonsuz döngü riski)
    if (signal.source === "system_event") return;

    this.processingQueue.push(signal);
    this.processNext();
  }

  /**
   * Kuyruktaki sonraki sinyali işle
   */
  private async processNext(): Promise<void> {
    if (this.isProcessing || this.processingQueue.length === 0) return;

    this.isProcessing = true;
    const signal = this.processingQueue.shift()!;

    try {
      await this.processPipeline(signal);
    } catch (err) {
      console.error(`[Cortex] Pipeline error for ${signal.source}/${signal.type}:`, err);
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)), signal);
    } finally {
      this.isProcessing = false;
      // Kuyrukta başka sinyal varsa devam et
      if (this.processingQueue.length > 0) {
        // Microtask ile bir sonrakini işle — stack overflow'dan kaçın
        queueMicrotask(() => this.processNext());
      }
    }
  }

  /**
   * Tam pipeline: Signal → Salience → Reasoner → Actions
   */
  private async processPipeline(signal: Signal): Promise<void> {
    // 1. Salience Filter
    const userContext = this.config.userContextProvider
      ? await this.config.userContextProvider(signal.userId)
      : "";

    const salience = await salienceFilter.evaluate(signal, userContext);

    // Eşik altı — düşür
    if (salience.score < salienceFilter.getThreshold()) {
      console.log(`[Cortex] Signal dropped: ${signal.source}/${signal.type} score=${salience.score} < threshold=${salienceFilter.getThreshold()}`);
      return;
    }

    // 2. Reasoner
    const plan = await reasoner.decide(signal, salience, userContext);

    // none — aksiyon gerekmiyor
    if (plan.action === "none") {
      console.log(`[Cortex] No action needed for ${signal.source}/${signal.type}`);
      return;
    }

    // 3. Actions
    const result = await actionExecutor.execute(plan);

    // Callback
    this.config.onActionExecuted?.(signal, result);
  }

  /**
   * Pipeline istatistikleri
   */
  stats(): Record<string, unknown> {
    return {
      running: this.running,
      queueLength: this.processingQueue.length,
      signalBus: signalBus.stats(),
      salience: salienceFilter.stats(),
      reasoner: reasoner.stats(),
      actions: actionExecutor.stats(),
      expectations: {
        pending: expectations.pending().length,
        all: expectations.all().length,
      },
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Singleton
export const cortex = new Cortex();

/**
 * Cortex — Ana Orkestratör
 *
 * Signal Bus → Salience Filter → Reasoner → Actions
 *
 * Tüm katmanları birleştirir, sinyalleri pipeline'dan geçirir.
 * Start/stop lifecycle yönetimi.
 */

import { config as appConfig } from "../config.ts";
import { signalBus, type Signal } from "./signal-bus.ts";
import { expectations } from "./expectations.ts";
import { salienceFilter } from "./salience.ts";
import { reasoner } from "./reasoner.ts";
import { actionExecutor, type ActionResult } from "./actions.ts";
import { wasRecentlyReplied } from "../services/reply-dedup.ts";
import { geminiBreaker } from "./utils.ts";

// Re-export everything
export { signalBus, expectations, salienceFilter, reasoner, actionExecutor, geminiBreaker };
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
  private readonly MAX_QUEUE_SIZE = appConfig.CORTEX_MAX_QUEUE_SIZE;

  // ── Pipeline Metrics ────────────────────────────────────────────────────
  private _processed = 0;
  private _droppedQueueFull = 0;
  private _droppedDedup = 0;
  private _droppedBelowThreshold = 0;
  private _actioned = 0;
  private _errors = 0;
  private _totalLatencyMs = 0;

  /**
   * Cortex'i başlat
   */
  async start(config: CortexConfig = {}): Promise<void> {
    if (this.running) return;

    this.config = config;

    // Expectations'ı yükle
    await expectations.load();

    // Signal Bus'a abone ol ÖNCE — cleanExpired timeout sinyallerini kaçırmamak için
    signalBus.on("signal", (signal: Signal) => {
      this.enqueue(signal);
    });

    // Signal Bus'ı başlat
    signalBus.start();

    // İlk temizlik — listener zaten kayıtlı, timeout sinyalleri yakalanacak
    expectations.cleanExpired();

    // Periyodik beklenti temizliği
    this.expiryInterval = setInterval(() => {
      expectations.cleanExpired();
    }, appConfig.CORTEX_EXPECTATION_CLEANUP_INTERVAL_MS);

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

    if (this.processingQueue.length >= this.MAX_QUEUE_SIZE) {
      const dropped = this.processingQueue.shift();
      this._droppedQueueFull++;
      console.warn(`[Cortex] Queue full (${this.MAX_QUEUE_SIZE}), dropped oldest: ${dropped?.source}/${dropped?.type}`);
    }

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
      this._errors++;
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
    const startTime = Date.now();
    this._processed++;

    // Dedup: proactive already replied to this chat — skip pipeline
    if (signal.type === "whatsapp_message") {
      const chatJid = (signal.data as Record<string, unknown>)?.chatJid as string;
      if (chatJid && wasRecentlyReplied(chatJid)) {
        this._droppedDedup++;
        this._totalLatencyMs += Date.now() - startTime;
        console.log(`[Cortex] Skipping whatsapp_message for ${chatJid} — proactive already replied`);
        return;
      }
    }

    // 1. Salience Filter
    const userContext = this.config.userContextProvider
      ? await this.config.userContextProvider(signal.userId)
      : "";

    const salience = await salienceFilter.evaluate(signal, userContext);

    // Eşik altı — düşür
    if (salience.score < salienceFilter.getThreshold()) {
      this._droppedBelowThreshold++;
      this._totalLatencyMs += Date.now() - startTime;
      console.log(`[Cortex] Signal dropped: ${signal.source}/${signal.type} score=${salience.score} < threshold=${salienceFilter.getThreshold()}`);
      return;
    }

    // 2. Reasoner
    const plan = await reasoner.decide(signal, salience, userContext);

    // none — aksiyon gerekmiyor
    if (plan.action === "none") {
      this._totalLatencyMs += Date.now() - startTime;
      console.log(`[Cortex] No action needed for ${signal.source}/${signal.type}`);
      return;
    }

    // 3. Actions
    const result = await actionExecutor.execute(plan);
    this._actioned++;
    this._totalLatencyMs += Date.now() - startTime;

    // Callback
    this.config.onActionExecuted?.(signal, result);
  }

  /**
   * Pipeline istatistikleri
   */
  stats(): Record<string, unknown> {
    const totalDropped = this._droppedQueueFull + this._droppedDedup + this._droppedBelowThreshold;
    return {
      running: this.running,
      queueSize: this.processingQueue.length,
      processed: this._processed,
      dropped: totalDropped,
      droppedQueueFull: this._droppedQueueFull,
      droppedDedup: this._droppedDedup,
      droppedBelowThreshold: this._droppedBelowThreshold,
      actioned: this._actioned,
      errors: this._errors,
      avgLatencyMs: this._processed > 0 ? Math.round(this._totalLatencyMs / this._processed) : 0,
      signalBus: signalBus.stats(),
      salience: salienceFilter.stats(),
      reasoner: reasoner.stats(),
      actions: actionExecutor.stats(),
      expectations: {
        pending: expectations.pending().length,
        all: expectations.all().length,
      },
      circuitBreaker: geminiBreaker.stats(),
    };
  }

  isRunning(): boolean {
    return this.running;
  }
}

// Singleton
export const cortex = new Cortex();

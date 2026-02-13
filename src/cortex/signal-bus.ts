/**
 * Cortex Layer 0: Signal Bus (Beyin Sapı)
 *
 * Tüm sinyaller buraya akar. Filtrelemez, sadece toplar ve dağıtır.
 * EventEmitter tabanlı pub/sub sistemi.
 *
 * Sinyal kaynakları:
 * - whatsapp_message: WhatsApp'tan gelen mesajlar
 * - user_message: Telegram'dan kullanıcı mesajları
 * - time_tick: Zamanlayıcı tick'leri
 * - system_event: Restart, hata, deploy gibi sistem olayları
 * - location_change: Konum değişikliği
 * - expectation_timeout: Beklenti zaman aşımı
 */

import { EventEmitter } from "node:events";

// ── Signal Types ──────────────────────────────────────────────────────────

export type SignalSource =
  | "whatsapp_message"
  | "user_message"
  | "time_tick"
  | "system_event"
  | "location_change"
  | "expectation_timeout"
  | "whatsapp_reaction"
  | "email_received"
  | "reminder_triggered"
  | "mood_change";

export interface Signal {
  /** Unique signal ID */
  id: string;
  /** Signal kaynağı */
  source: SignalSource;
  /** Sinyal tipi (source içinde alt kategori) */
  type: string;
  /** Sinyal verisi — kaynağa göre değişir */
  data: Record<string, unknown>;
  /** Oluşturulma zamanı */
  timestamp: number;
  /** Opsiyonel: sinyalin ilişkili olduğu kullanıcı */
  userId?: number;
  /** Opsiyonel: sinyalin ilişkili olduğu kişi (WhatsApp, email vs.) */
  contactId?: string;
}

// ── Signal Bus ────────────────────────────────────────────────────────────

class SignalBus extends EventEmitter {
  private signalLog: Signal[] = [];
  private maxLogSize = 200;
  private started = false;

  constructor() {
    super();
    this.setMaxListeners(50); // Çok sayıda listener olabilir
  }

  /**
   * Yeni sinyal yayınla
   * Tüm subscriber'lar bu sinyali alır
   */
  override emit(event: "signal", signal: Signal): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Sinyal dinle
   */
  override on(event: "signal", listener: (signal: Signal) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /**
   * Yeni sinyal oluştur ve yayınla
   */
  push(source: SignalSource, type: string, data: Record<string, unknown> = {}, extra: Partial<Pick<Signal, "userId" | "contactId">> = {}): Signal {
    const signal: Signal = {
      id: `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      source,
      type,
      data,
      timestamp: Date.now(),
      ...extra,
    };

    // Log'a ekle (ring buffer)
    this.signalLog.push(signal);
    if (this.signalLog.length > this.maxLogSize) {
      this.signalLog.shift();
    }

    // Debug log
    console.log(`[Cortex:Signal] ${signal.source}/${signal.type} ${signal.contactId ? `from=${signal.contactId}` : ""} ${JSON.stringify(signal.data).slice(0, 100)}`);

    // Yayınla
    this.emit("signal", signal);

    return signal;
  }

  /**
   * Son N sinyali getir
   */
  recent(count: number = 20): Signal[] {
    return this.signalLog.slice(-count);
  }

  /**
   * Belirli bir kaynaktan gelen son sinyalleri getir
   */
  recentBySource(source: SignalSource, count: number = 10): Signal[] {
    return this.signalLog
      .filter(s => s.source === source)
      .slice(-count);
  }

  /**
   * Belirli bir kişiyle ilgili son sinyalleri getir
   */
  recentByContact(contactId: string, count: number = 10): Signal[] {
    return this.signalLog
      .filter(s => s.contactId === contactId)
      .slice(-count);
  }

  /**
   * Sinyal log'unu temizle
   */
  clearLog(): void {
    this.signalLog = [];
  }

  /**
   * İstatistikler
   */
  stats(): { total: number; bySource: Record<string, number> } {
    const bySource: Record<string, number> = {};
    for (const s of this.signalLog) {
      bySource[s.source] = (bySource[s.source] || 0) + 1;
    }
    return { total: this.signalLog.length, bySource };
  }

  /**
   * Bus'ı başlat
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    console.log("[Cortex:SignalBus] Started");

    // Başlangıç sinyali
    this.push("system_event", "bus_started", { timestamp: Date.now() });
  }

  /**
   * Bus'ı durdur
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.removeAllListeners();
    console.log("[Cortex:SignalBus] Stopped");
  }

  isRunning(): boolean {
    return this.started;
  }
}

// Singleton instance
export const signalBus = new SignalBus();

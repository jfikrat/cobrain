/**
 * Expectations (Pending Actions / Beklentiler)
 *
 * "Ne bekliyorum?" state'i. Bir aksiyon yapıldığında (mesaj gönderildi,
 * araştırma başlatıldı) buraya bir beklenti kaydedilir.
 */

import { join } from "node:path";
import { config } from "../config.ts";

// ── Types ─────────────────────────────────────────────────────────────────

export type ExpectationType =
  | "whatsapp_reply"      // Birinden WhatsApp cevabı bekliyorum
  | "research_result"     // Araştırma sonucu bekliyorum
  | "reminder_followup"   // Hatırlatıcı sonrası takip
  | "location_arrival"    // Bir konuma varış bekliyorum
  | "user_confirmation"   // Kullanıcıdan onay bekliyorum
  | "scheduled_task"      // Zamanlanmış görev
  | "custom";             // Özel beklenti

export interface PendingExpectation {
  /** Unique ID */
  id: string;
  /** Beklenti tipi */
  type: ExpectationType;
  /** Hedef kişi veya kaynak (WhatsApp numarası, URL, vs.) */
  target: string;
  /** Beklentinin bağlamı — neden bekliyoruz */
  context: string;
  /** Ne yapılacak — resolve olduğunda */
  onResolved: string;
  /** Oluşturulma zamanı */
  createdAt: number;
  /** Zaman aşımı (ms) — 0 = sınırsız */
  timeout: number;
  /** İlişkili kullanıcı */
  userId: number;
  /** Durum */
  status: "pending" | "resolved" | "expired";
  /** Çözülme zamanı */
  resolvedAt?: number;
  /** Çözülme verisi */
  resolvedData?: Record<string, unknown>;
}

// ── Expectations Manager ──────────────────────────────────────────────────

const DATA_FILE = join(process.cwd(), "data", "expectations.json");

class ExpectationsManager {
  private expectations: PendingExpectation[] = [];
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();

  /**
   * Dosyadan yükle
   */
  async load(): Promise<void> {
    try {
      const file = Bun.file(DATA_FILE);
      if (await file.exists()) {
        const data = await file.json();
        this.expectations = data.expectations || [];
      }
    } catch (err) {
      console.warn("[Expectations] Failed to load:", err);
      this.expectations = [];
    }
    this.loaded = true;
    console.log(`[Expectations] Loaded ${this.pending().length} pending expectations`);
  }

  async save(): Promise<void> {
    this.saving = this.saving.then(() => this._doSave()).catch(() => {});
    return this.saving;
  }

  private async _doSave(): Promise<void> {
    try {
      const tmpPath = `${DATA_FILE}.tmp.${Date.now()}`;
      await Bun.write(tmpPath, JSON.stringify({ expectations: this.expectations }, null, 2));
      const fs = await import("node:fs/promises");
      await fs.rename(tmpPath, DATA_FILE);
    } catch (err) {
      console.warn("[Expectations] Failed to save:", err);
    }
  }

  /**
   * Yeni beklenti oluştur
   */
  async create(params: {
    type: ExpectationType;
    target: string;
    context: string;
    onResolved: string;
    userId: number;
    timeout?: number; // ms, default 30 dakika
  }): Promise<PendingExpectation> {
    const expectation: PendingExpectation = {
      id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: params.type,
      target: params.target,
      context: params.context,
      onResolved: params.onResolved,
      userId: params.userId,
      timeout: params.timeout ?? config.CORTEX_EXPECTATION_TIMEOUT_MS,
      createdAt: Date.now(),
      status: "pending",
    };

    this.expectations.push(expectation);
    await this.save();

    console.log(`[Expectations] Created: ${expectation.type} target=${expectation.target} "${expectation.context}"`);

    return expectation;
  }

  /**
   * Beklentiyi çöz
   */
  async resolve(id: string, data: Record<string, unknown> = {}): Promise<PendingExpectation | null> {
    const exp = this.expectations.find(e => e.id === id && e.status === "pending");
    if (!exp) return null;

    exp.status = "resolved";
    exp.resolvedAt = Date.now();
    exp.resolvedData = data;
    await this.save();

    const duration = Math.round((exp.resolvedAt - exp.createdAt) / 1000);
    console.log(`[Expectations] Resolved: ${exp.type} target=${exp.target} (${duration}s)`);

    return exp;
  }

  /**
   * Zaman aşımına uğramış beklentileri temizle
   */
  cleanExpired(): PendingExpectation[] {
    const now = Date.now();
    const expired: PendingExpectation[] = [];

    for (const exp of this.expectations) {
      if (exp.status === "pending" && exp.timeout > 0) {
        if (now - exp.createdAt > exp.timeout) {
          exp.status = "expired";
          expired.push(exp);
        }
      }
    }

    if (expired.length > 0) {
      console.log(`[Expectations] ${expired.length} expectations expired`);
      this.save(); // async, fire-and-forget
    }

    return expired;
  }

  /**
   * Bekleyen beklentiler
   */
  pending(): PendingExpectation[] {
    return this.expectations.filter(e => e.status === "pending");
  }

  /**
   * Belirli bir kullanıcının bekleyen beklentileri
   */
  pendingForUser(userId: number): PendingExpectation[] {
    return this.expectations.filter(e => e.status === "pending" && e.userId === userId);
  }

  /**
   * Tüm beklentiler (debug)
   */
  all(): PendingExpectation[] {
    return [...this.expectations];
  }

  /**
   * Eski resolved/expired kayıtları temizle (7 günden eski)
   */
  async prune(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const before = this.expectations.length;
    const cutoff = Date.now() - maxAge;
    this.expectations = this.expectations.filter(e => {
      if (e.status === "pending") return true;
      return e.createdAt > cutoff;
    });
    const removed = before - this.expectations.length;
    if (removed > 0) {
      await this.save();
      console.log(`[Expectations] Pruned ${removed} old entries`);
    }
    return removed;
  }
}

// Singleton
export const expectations = new ExpectationsManager();

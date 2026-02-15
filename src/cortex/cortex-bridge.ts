/**
 * Cortex Bridge — Sen'e tier-2 sorularını sor
 *
 * WhatsApp DM'ler Cortex'te işleniyor. Tier-2 (önemli ama açık karar)
 * veya tierindeki belirsiz durumlar için sana Telegram'dan soruyorum.
 *
 * Ayrıca hafızadan ögreniyorum: Burak'tan gelen soruların patternleri
 * birikip zamanla otomatik cevap verebilir hale geliyorum.
 */

import { type Signal } from "./signal-bus.ts";
import { type SalienceResult } from "./salience.ts";
import { type ActionPlan } from "./reasoner.ts";
import { SmartMemory } from "../memory/smart-memory.ts";
import { userManager } from "../services/user-manager.ts";

export interface Tier2Feedback {
  signal: Signal;
  salience: SalienceResult;
  reasoner: ActionPlan;
  senderName: string;
  preview: string;
  conversationHistory?: string[];
}

export interface CortexBridgeConfig {
  /** Tier-2 sorularını sana iletecek callback */
  onTier2Question?: (feedback: Tier2Feedback) => Promise<void>;
  /** Tier-3 veya belirsiz durumları loglayacak callback */
  onTier3OrUnclear?: (feedback: Tier2Feedback) => Promise<void>;
}

class CortexBridge {
  private config: CortexBridgeConfig = {};

  /**
   * Bridge'i konfigüre et
   */
  configure(config: CortexBridgeConfig): void {
    this.config = config;
  }

  /**
   * WhatsApp DM sinyalini kontrol et, tier-2 ise sana sor
   */
  async handleWhatsAppDM(
    signal: Signal,
    salience: SalienceResult,
    reasoner: ActionPlan,
    userId: number
  ): Promise<void> {
    const data = signal.data as Record<string, unknown>;
    const senderName = (data.senderName as string) || "Unknown";
    const chatJid = (data.chatJid as string) || "";
    const preview = (data.preview as string) || "";
    const conversationHistory = (data.conversationHistory as string[]) || [];

    const feedback: Tier2Feedback = {
      signal,
      salience,
      reasoner,
      senderName,
      preview,
      conversationHistory,
    };

    // Tier-2 heuristic: reasoning'de "kontrol et", "açık karar", "soruş" varsa tier-2
    const isTier2 =
      reasoner.reasoning.includes("açık karar") ||
      reasoner.reasoning.includes("kontrol et") ||
      reasoner.reasoning.includes("soruş") ||
      salience.score >= 0.7; // Yüksek önem = tier-2 olasılığı

    if (isTier2) {
      console.log(`[CortexBridge] Tier-2 WhatsApp: ${senderName} - önem ${salience.score}`);
      await this.config.onTier2Question?.(feedback);

      // Hafızaya öğren: bu kişi tier-2 soruları soruyor
      await this.learnFromInteraction(userId, senderName, true, preview);
    } else {
      console.log(`[CortexBridge] Tier-3/uncertain WhatsApp: ${senderName}`);
      await this.config.onTier3OrUnclear?.(feedback);

      // Hafızaya öğren: bu kişi tier-3 mesajları gönderuyor
      await this.learnFromInteraction(userId, senderName, false, preview);
    }
  }

  /**
   * WhatsApp interaksiyonundan öğren
   */
  private async learnFromInteraction(
    userId: number,
    senderName: string,
    isTier2: boolean,
    messagePreview: string
  ): Promise<void> {
    try {
      const userFolder = userManager.getUserFolder(userId);
      const memory = new SmartMemory(userFolder, userId);

      // Burak'a gelen soruların tipi hakkında bilgi kaydet
      const pattern = isTier2 ? "önemli sorular soruyor" : "bilgi paylaşıyor veya selamlama";
      const content = `${senderName}: ${pattern} - örnek: "${messagePreview.slice(0, 100)}"`;

      await memory.store({
        type: "episodic",
        content,
        importance: isTier2 ? 0.7 : 0.4,
        source: "cortex-bridge",
        metadata: { context: `WhatsApp interaction - ${senderName}` },
      });

      memory.close();
    } catch (err) {
      console.error(`[CortexBridge] Failed to learn from interaction:`, err);
    }
  }
}

export const cortexBridge = new CortexBridge();

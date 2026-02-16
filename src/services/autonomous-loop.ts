import { readFileSync } from "fs";
import { resolve } from "path";
import { bot } from "../channels/telegram.ts";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";

interface LoopContext {
  time: {
    now: Date;
    hour: number;
    minute: number;
    dayPart: "sabah" | "öğle" | "akşam" | "gece";
    day: string;
    isWorkHours: boolean;
  };
  location: {
    current: { lat: number; lng: number; label: string } | null;
    hasLocationData: boolean;
  };
  whatsapp: {
    unreadMessages: Array<{
      from: string;
      message: string;
      time: Date;
      chatId: string;
    }>;
    messageCount: number;
  };
  memory: {
    routines: string;
    people: string;
    autoReplies: string;
    locations: string;
  };
}

class AutonomousLoop {
  private isRunning = false;
  private lastTick: Date | null = null;
  private tickInterval: NodeJS.Timeout | null = null;
  private tickCount = 0;

  async start() {
    if (this.isRunning) {
      logger.warn("[AutonomousLoop] Zaten çalışıyor");
      return;
    }

    this.isRunning = true;
    logger.info("[AutonomousLoop] Başlatıldı (30 saniye döngüsü)");

    // İlk tick'i hemen çalıştır
    await this.tick();

    // Sonraki tick'leri 30 saniye arayla
    this.tickInterval = setInterval(async () => {
      await this.tick();
    }, 30 * 1000); // 30 saniye
  }

  async stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    this.isRunning = false;
    logger.info("[AutonomousLoop] Durduruldu");
  }

  private async tick() {
    this.tickCount++;

    try {
      this.lastTick = new Date();

      logger.debug(`[AutonomousLoop] Tick #${this.tickCount}`);

      // 1. Bağlamı topla
      const context = await this.gatherContext();

      // 2. LLM'e sor: "Ne yapmalıyım?"
      const decision = await this.think(context);

      // 3. Karar varsa uygula
      if (decision.shouldAct && decision.actions && decision.actions.length > 0) {
        await this.executeActions(decision.actions);
      }
    } catch (err) {
      logger.error("[AutonomousLoop] Tick hatası:", err);
    }
  }

  private async gatherContext(): Promise<LoopContext> {
    const now = new Date();
    const hour = now.getHours();
    const dayPart = this.getDayPart(hour);
    const day = now.toLocaleString("tr-TR", { weekday: "long" });

    // İş saatlerinde mi? (09:30-17:30, Pazartesi-Cuma)
    const dayOfWeek = now.getDay();
    const isWorkHours = hour >= 9 && hour < 18 && dayOfWeek >= 1 && dayOfWeek <= 5;

    // Markdown dosyalarını oku
    const knowledgePath = resolve("/home/fjds/projects/cobrain/knowledge");
    const routines = this.readKnowledge(knowledgePath, "routines.md");
    const people = this.readKnowledge(knowledgePath, "people.md");
    const autoReplies = this.readKnowledge(knowledgePath, "auto_replies.md");
    const locations = this.readKnowledge(knowledgePath, "locations.md");

    // WhatsApp okunmamış mesajlarını al
    const unreadMessages = await this.getUnreadWhatsAppMessages();

    // Konum bilgisini al
    const currentLocation = await this.getCurrentLocation();

    return {
      time: {
        now,
        hour,
        minute: now.getMinutes(),
        dayPart,
        day,
        isWorkHours,
      },
      location: {
        current: currentLocation,
        hasLocationData: !!currentLocation,
      },
      whatsapp: {
        unreadMessages,
        messageCount: unreadMessages.length,
      },
      memory: {
        routines,
        people,
        autoReplies,
        locations,
      },
    };
  }

  private async think(context: LoopContext): Promise<any> {
    const prompt = `
Sen Cobrain, Fikret'in kişisel AI asistanısın. Şu an otonom loop içindesin.

# ŞU ANKİ BAĞLAM
Zaman: ${context.time.now.toLocaleString("tr-TR")}
Gün: ${context.time.day}
Saat Tipi: ${context.time.dayPart}
İş Saati mi: ${context.time.isWorkHours ? "Evet" : "Hayır"}

Konum: ${context.location.current?.label || "bilinmiyor"}
${context.location.hasLocationData ? `Koordinat: (${context.location.current?.lat}, ${context.location.current?.lng})` : ""}

WhatsApp: ${context.whatsapp.messageCount} okunmamış mesaj
${
  context.whatsapp.messageCount > 0
    ? `
Mesajlar:
${context.whatsapp.unreadMessages
  .slice(0, 5)
  .map((m) => `- ${m.from}: "${m.message.slice(0, 80)}..."`)
  .join("\n")}
`
    : ""
}

# HAFIZA (Bilgi Tabanı)

## Rutinler
${context.memory.routines}

## Kişiler
${context.memory.people}

## Otomatik Cevap Kuralları
${context.memory.autoReplies}

## Konumlar
${context.memory.locations}

---

# GÖREV

Yukarıdaki bağlamı ve hafızanı kullanarak, şu an ne yapmalısın?

**Analiz Et:**
1. WhatsApp'ta okunmamış mesaj var mı?
2. Hangi mesajlar TIER-1 (otomatik cevap)?
3. Hangi mesajlar TIER-2 (Fikret'e sor)?
4. Proaktif bir şey yapmalı mısın? (trafik bilgisi, hareket algılama, vs)
5. Beklemesi gereken bir şey var mı?

**Cevap formatı (Lütfen sadece JSON ver, başka yazı yazma):**

{
  "reasoning": "Neden bu kararları aldın?",
  "shouldAct": true/false,
  "actions": [
    {
      "type": "whatsapp_reply",
      "to": "kişi adı",
      "chatId": "WhatsApp kişi ID'si (opsiyonel)",
      "message": "gönderilecek mesaj",
      "reason": "neden bu mesajı gönderiyor?"
    },
    {
      "type": "ask_user",
      "message": "Fikret'e sorulacak soru",
      "reason": "neden soruyorsun?"
    },
    {
      "type": "proactive_info",
      "to": "kişi adı",
      "message": "bilgilendirme mesajı",
      "reason": "neden bu bilgiyi gönderiyorsun?"
    }
  ]
}

Sadece JSON ver, başka birşey yazma.
`;

    try {
      const response = await gemini.generateContent(prompt);

      // JSON'u metinden çıkar
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn("[AutonomousLoop] JSON bulunamadı, yanıt:", response.slice(0, 200));
        return { shouldAct: false };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    } catch (err) {
      logger.error("[AutonomousLoop] LLM yanıtı parse edilemedi:", err);
      return { shouldAct: false };
    }
  }

  private async executeActions(actions: any[]) {
    for (const action of actions) {
      try {
        if (action.type === "whatsapp_reply") {
          logger.info(`[AutonomousLoop] WhatsApp gönderiliyor: ${action.to}`);
          try {
            const { whatsappDB } = await import("./whatsapp-db.ts");
            whatsappDB.sendMessage(action.to, action.message);
          } catch (err) {
            logger.error(`[AutonomousLoop] WhatsApp DB hatası:`, err);
          }
        } else if (action.type === "ask_user") {
          logger.info(`[AutonomousLoop] Fikret'e sorulacak`);
          const msg = `🤔 ${action.message}\n\nNe yapmalıyım?`;
          try {
            await bot.api.sendMessage(config.MY_TELEGRAM_ID, msg);
          } catch (err) {
            logger.error(`[AutonomousLoop] Telegram hatası:`, err);
          }
        } else if (action.type === "proactive_info") {
          logger.info(`[AutonomousLoop] Proaktif bilgi: ${action.to}`);
          try {
            const { whatsappDB } = await import("./whatsapp-db.ts");
            whatsappDB.sendMessage(action.to, action.message);
          } catch (err) {
            logger.error(`[AutonomousLoop] WhatsApp DB hatası:`, err);
          }
        }
      } catch (err) {
        logger.error(`[AutonomousLoop] Action hatası (${action.type}):`, err);
      }
    }
  }

  private async getUnreadWhatsAppMessages() {
    try {
      const notifications = await whatsapp.getNotifications({ limit: 20 });
      return (notifications || []).map((n: any) => ({
        from: n.from?.name || n.from?.id || "Bilinmiyor",
        message: n.body || "",
        time: new Date(),
        chatId: n.from?.id || "",
      }));
    } catch (err) {
      logger.warn("[AutonomousLoop] WhatsApp mesajları alınamadı:", err);
      return [];
    }
  }

  private async getCurrentLocation() {
    try {
      // Telegram live location'dan kontrol et
      const { LocationService } = await import("./location.ts");
      const userId = config.MY_TELEGRAM_ID;
      // Kullanıcı veritabanından konum al
      // Not: Tam implementasyon location service'in mevcut API'sine bağlı
      // Şimdilik null döndür, sonra geliştirilecek
      return null;
    } catch (err) {
      logger.warn("[AutonomousLoop] Konum alınamadı:", err);
      return null;
    }
  }

  private readKnowledge(basePath: string, fileName: string): string {
    try {
      const filePath = resolve(basePath, fileName);
      const content = readFileSync(filePath, "utf-8");
      return content;
    } catch (err) {
      logger.warn(`[AutonomousLoop] Dosya okunamadı: ${fileName}`);
      return "Bilgi eksik";
    }
  }

  private getDayPart(hour: number): "sabah" | "öğle" | "akşam" | "gece" {
    if (hour >= 6 && hour < 12) return "sabah";
    if (hour >= 12 && hour < 18) return "öğle";
    if (hour >= 18 && hour < 24) return "akşam";
    return "gece";
  }

  getStatus() {
    return {
      running: this.isRunning,
      lastTick: this.lastTick,
      tickCount: this.tickCount,
      status: this.isRunning ? "Aktif" : "İnaktif",
    };
  }
}

export const autonomousLoop = new AutonomousLoop();

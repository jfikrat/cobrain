/**
 * Phone Tools for Cobrain Agent
 * MCP tools for phone/Termux-API integration
 * Allows Cobrain to take photos, record audio, get location etc.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";
import {
  getPhones,
  isPhoneOnline,
  sendPhoneCommand,
  getPhoneMedia,
  requestPhoto,
  requestAudio,
  requestLocation,
} from "../../services/phone-agent.ts";

/**
 * List connected phones
 */
export const phoneListTool = tool(
  "phone_list",
  "Bağlı telefonları listele. Hangi telefonların çevrimiçi olduğunu gösterir.",
  {},
  async () => {
    try {
      const phones = getPhones();

      if (phones.length === 0) {
        return toolSuccess("Hiç telefon bağlı değil. Telefonda phone-agent.sh çalışıyor olmalı.");
      }

      const formatted = phones
        .map((p) => {
          const status = isPhoneOnline(p.id) ? "🟢 çevrimiçi" : "🔴 çevrimdışı";
          return `- ${p.name} (${p.id}): ${status}\n  Yetenekler: ${p.capabilities.join(", ")}`;
        })
        .join("\n");

      return toolSuccess(`Bağlı telefonlar:\n${formatted}`);
    } catch (error) {
      return toolError("Telefon listesi alınamadı", error);
    }
  }
);

/**
 * Take a photo with phone camera
 */
export const phonePhotoTool = tool(
  "phone_photo",
  "Telefonun kamerasıyla fotoğraf çek. Kullanıcıyı görmek, çevreyi görmek için kullan.",
  {
    phone_id: z
      .string()
      .optional()
      .describe("Telefon ID'si (belirtilmezse ilk çevrimiçi telefon kullanılır)"),
    camera: z
      .enum(["front", "back"])
      .default("front")
      .describe("Kamera: front (ön/selfie) veya back (arka)"),
  },
  async ({ phone_id, camera }) => {
    try {
      // Find phone to use
      let targetPhoneId = phone_id;

      if (!targetPhoneId) {
        const phones = getPhones();
        const onlinePhone = phones.find((p) => isPhoneOnline(p.id));
        if (!onlinePhone) {
          return toolError("Çevrimiçi telefon bulunamadı", new Error("No online phone"));
        }
        targetPhoneId = onlinePhone.id;
      }

      if (!isPhoneOnline(targetPhoneId)) {
        return toolError("Telefon çevrimdışı", new Error(`Phone ${targetPhoneId} is offline`));
      }

      console.log(`[Phone] Taking photo with ${camera} camera on ${targetPhoneId}`);

      const result = await requestPhoto(targetPhoneId, camera);

      if (!result.success) {
        return toolError(`Fotoğraf çekilemedi: ${result.error}`, new Error(result.error));
      }

      return toolSuccess(
        `📸 Fotoğraf çekildi!\nTelefon: ${targetPhoneId}\nKamera: ${camera}\nDosya: ${result.path || "kaydedildi"}`
      );
    } catch (error) {
      return toolError("Fotoğraf çekme hatası", error);
    }
  }
);

/**
 * Record audio with phone microphone
 */
export const phoneAudioTool = tool(
  "phone_audio",
  "Telefonun mikrofonuyla ses kaydet. Ortamı dinlemek, sesli not almak için kullan.",
  {
    phone_id: z.string().optional().describe("Telefon ID'si"),
    duration: z
      .number()
      .min(1)
      .max(60)
      .default(5)
      .describe("Kayıt süresi (saniye, 1-60)"),
  },
  async ({ phone_id, duration }) => {
    try {
      let targetPhoneId = phone_id;

      if (!targetPhoneId) {
        const phones = getPhones();
        const onlinePhone = phones.find((p) => isPhoneOnline(p.id));
        if (!onlinePhone) {
          return toolError("Çevrimiçi telefon bulunamadı", new Error("No online phone"));
        }
        targetPhoneId = onlinePhone.id;
      }

      if (!isPhoneOnline(targetPhoneId)) {
        return toolError("Telefon çevrimdışı", new Error(`Phone ${targetPhoneId} is offline`));
      }

      console.log(`[Phone] Recording ${duration}s audio on ${targetPhoneId}`);

      const result = await requestAudio(targetPhoneId, duration);

      if (!result.success) {
        return toolError(`Ses kaydedilemedi: ${result.error}`, new Error(result.error));
      }

      return toolSuccess(
        `🎤 Ses kaydedildi!\nTelefon: ${targetPhoneId}\nSüre: ${duration} saniye\nDosya: ${result.path || "kaydedildi"}`
      );
    } catch (error) {
      return toolError("Ses kaydetme hatası", error);
    }
  }
);

/**
 * Get phone location
 */
export const phoneLocationTool = tool(
  "phone_location",
  "Telefonun konumunu al. Kullanıcının nerede olduğunu öğrenmek için kullan.",
  {
    phone_id: z.string().optional().describe("Telefon ID'si"),
  },
  async ({ phone_id }) => {
    try {
      let targetPhoneId = phone_id;

      if (!targetPhoneId) {
        const phones = getPhones();
        const onlinePhone = phones.find((p) => isPhoneOnline(p.id));
        if (!onlinePhone) {
          return toolError("Çevrimiçi telefon bulunamadı", new Error("No online phone"));
        }
        targetPhoneId = onlinePhone.id;
      }

      if (!isPhoneOnline(targetPhoneId)) {
        return toolError("Telefon çevrimdışı", new Error(`Phone ${targetPhoneId} is offline`));
      }

      console.log(`[Phone] Getting location from ${targetPhoneId}`);

      const result = await requestLocation(targetPhoneId);

      if (!result.success || !result.location) {
        return toolError(`Konum alınamadı: ${result.error}`, new Error(result.error));
      }

      const { lat, lon } = result.location;
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;

      return toolSuccess(
        `📍 Konum alındı!\nTelefon: ${targetPhoneId}\nEnlem: ${lat}\nBoylam: ${lon}\nHarita: ${mapsUrl}`
      );
    } catch (error) {
      return toolError("Konum alma hatası", error);
    }
  }
);

/**
 * Get phone battery status
 */
export const phoneBatteryTool = tool(
  "phone_battery",
  "Telefonun pil durumunu öğren.",
  {
    phone_id: z.string().optional().describe("Telefon ID'si"),
  },
  async ({ phone_id }) => {
    try {
      let targetPhoneId = phone_id;

      if (!targetPhoneId) {
        const phones = getPhones();
        const onlinePhone = phones.find((p) => isPhoneOnline(p.id));
        if (!onlinePhone) {
          return toolError("Çevrimiçi telefon bulunamadı", new Error("No online phone"));
        }
        targetPhoneId = onlinePhone.id;
      }

      if (!isPhoneOnline(targetPhoneId)) {
        return toolError("Telefon çevrimdışı", new Error(`Phone ${targetPhoneId} is offline`));
      }

      const result = await sendPhoneCommand(targetPhoneId, "battery");

      if (!result.success) {
        return toolError(`Pil durumu alınamadı: ${result.error}`, new Error(result.error));
      }

      const battery = result.data as { percentage?: number; status?: string; temperature?: number };

      return toolSuccess(
        `🔋 Pil Durumu:\nTelefon: ${targetPhoneId}\nŞarj: ${battery.percentage || "?"}%\nDurum: ${battery.status || "bilinmiyor"}\nSıcaklık: ${battery.temperature || "?"}°C`
      );
    } catch (error) {
      return toolError("Pil durumu hatası", error);
    }
  }
);

/**
 * Get recent media from phones
 */
export const phoneMediaTool = tool(
  "phone_media",
  "Telefonlardan alınan son fotoğraf/ses dosyalarını listele.",
  {
    phone_id: z.string().optional().describe("Belirli telefon ID'si (boş bırakılırsa tümü)"),
    type: z
      .enum(["photo", "audio", "video"])
      .optional()
      .describe("Medya tipi filtresi"),
    limit: z.number().default(5).describe("Maksimum sonuç sayısı"),
  },
  async ({ phone_id, type, limit }) => {
    try {
      const media = await getPhoneMedia(phone_id, type, limit);

      if (media.length === 0) {
        return toolSuccess("Henüz kayıtlı medya yok.");
      }

      const formatted = media
        .map((m) => {
          const date = new Date(m.timestamp).toLocaleString("tr-TR");
          const icon = m.type === "photo" ? "📷" : m.type === "audio" ? "🎵" : "🎬";
          return `${icon} ${m.filename}\n   Tarih: ${date}\n   Cihaz: ${m.deviceId}`;
        })
        .join("\n\n");

      return toolSuccess(`Son medyalar:\n\n${formatted}`);
    } catch (error) {
      return toolError("Medya listesi hatası", error);
    }
  }
);

/**
 * Create MCP server with all phone tools
 */
export function createPhoneServer() {
  return createSdkMcpServer({
    name: "cobrain-phone",
    version: "1.0.0",
    tools: [
      phoneListTool,
      phonePhotoTool,
      phoneAudioTool,
      phoneLocationTool,
      phoneBatteryTool,
      phoneMediaTool,
    ],
  });
}

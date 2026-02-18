/**
 * Location Tools for Cobrain Agent
 * MCP tools: konum kaydetme, geocoding, mesafe hesaplama
 * Google Maps Routes API + Geocoding API
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { LocationService } from "../../services/location.ts";
import { userManager } from "../../services/user-manager.ts";
import { createUserCache } from "../../utils/user-cache.ts";
import { toolError, toolSuccess } from "../../utils/tool-response.ts";
import { getLiveLocation } from "../../channels/telegram.ts";

// User-based LocationService cache
const locationCache = createUserCache(async (userId: number) => {
  const userDb = await userManager.getUserDb(userId);
  return new LocationService(userDb);
});

// ========== LIVE LOCATION ==========

export const getUserLocationTool = (userId: number) =>
  tool(
    "get_user_location",
    "Kullanıcının anlık live location konumunu getir. Telegram'dan paylaşılan canlı konum varsa döner.",
    {},
    async () => {
      try {
        const entry = getLiveLocation(userId);

        if (!entry) {
          return toolSuccess("Aktif live location yok. Kullanıcı Telegram'dan canlı konum paylaşmıyor.");
        }

        const ageMs = Date.now() - entry.updatedAt.getTime();
        const ageSec = Math.round(ageMs / 1000);
        const ageText = ageSec < 60 ? `${ageSec} saniye önce` : `${Math.round(ageSec / 60)} dakika önce`;

        // Reverse geocode ile adres bul
        const locService = await locationCache.get(userId);
        let addressText = "";
        try {
          const result = await locService.reverseGeocode(entry.latitude, entry.longitude);
          if (result) addressText = `\nAdres: ${result.formattedAddress}`;
        } catch {
          // opsiyonel
        }

        return toolSuccess(
          `Kullanıcının anlık konumu (${ageText} güncellendi):\nKoordinat: ${entry.latitude}, ${entry.longitude}${addressText}`
        );
      } catch (error) {
        return toolError("Konum alınamadı", error);
      }
    }
  );

// ========== LOCATION SAVE/LIST ==========

export const saveLocationTool = (userId: number) =>
  tool(
    "save_location",
    "Konum kaydet veya güncelle. Koordinat (lat/lng) veya adres ile kayıt yapılabilir. Eğer adres verilirse otomatik geocode yapılır.",
    {
      name: z.string().describe("Konum adı (örn: 'ev', 'iş', 'park yeri', 'Galataport')"),
      label: z
        .enum(["ev", "iş", "park", "favori", "özel"])
        .default("özel")
        .describe("Konum etiketi"),
      latitude: z.number().optional().describe("Enlem (opsiyonel, adres verilirse gereksiz)"),
      longitude: z.number().optional().describe("Boylam (opsiyonel, adres verilirse gereksiz)"),
      address: z.string().optional().describe("Adres metni (geocode için kullanılır)"),
      notes: z.string().optional().describe("Ek notlar"),
    },
    async ({ name, label, latitude, longitude, address, notes }) => {
      try {
        const locService = await locationCache.get(userId);

        let lat = latitude;
        let lng = longitude;
        let resolvedAddress = address;

        // Eğer koordinat yok ama adres varsa, geocode yap
        if ((!lat || !lng) && address) {
          const geocoded = await locService.geocode(address);
          if (!geocoded) {
            return toolError("Adres bulunamadı", new Error(`"${address}" geocode edilemedi`));
          }
          lat = geocoded.latitude;
          lng = geocoded.longitude;
          resolvedAddress = geocoded.formattedAddress;
        }

        if (!lat || !lng) {
          return toolError(
            "Koordinat gerekli",
            new Error("Latitude/longitude veya adres belirtilmeli")
          );
        }

        // Eğer adres yoksa reverse geocode yap
        if (!resolvedAddress) {
          try {
            const reverseResult = await locService.reverseGeocode(lat, lng);
            if (reverseResult) {
              resolvedAddress = reverseResult.formattedAddress;
            }
          } catch {
            // Reverse geocode opsiyonel, hata olursa devam et
          }
        }

        const location = locService.saveLocation({
          name,
          label,
          latitude: lat,
          longitude: lng,
          address: resolvedAddress,
          notes,
        });

        console.log(`[Location] Saved "${name}" for user ${userId}: ${lat},${lng}`);

        const parts = [
          `Konum kaydedildi:`,
          `- Ad: ${location.name}`,
          `- Etiket: ${location.label}`,
          `- Koordinat: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`,
        ];
        if (location.address) parts.push(`- Adres: ${location.address}`);
        if (location.notes) parts.push(`- Not: ${location.notes}`);

        return toolSuccess(parts.join("\n"));
      } catch (error) {
        return toolError("Konum kaydedilemedi", error);
      }
    }
  );

export const listLocationsTool = (userId: number) =>
  tool(
    "list_locations",
    "Kayıtlı konumları listele.",
    {},
    async () => {
      try {
        const locService = await locationCache.get(userId);
        const locations = locService.getAllLocations();

        if (locations.length === 0) {
          return toolSuccess("Kayıtlı konum yok.");
        }

        const labelEmoji: Record<string, string> = {
          ev: "🏠",
          iş: "🏢",
          park: "🅿️",
          favori: "⭐",
          özel: "📍",
        };

        const formatted = locations
          .map((loc) => {
            const emoji = labelEmoji[loc.label] || "📍";
            const addr = loc.address ? ` — ${loc.address}` : "";
            return `${emoji} #${loc.id} ${loc.name} (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})${addr}`;
          })
          .join("\n");

        return toolSuccess(`Kayitli konumlar:\n${formatted}`);
      } catch (error) {
        return toolError("Konumlar listelenemedi", error);
      }
    }
  );

export const deleteLocationTool = (userId: number) =>
  tool(
    "delete_location",
    "Kayıtlı konumu sil.",
    {
      name: z.string().describe("Silinecek konum adı"),
    },
    async ({ name }) => {
      try {
        const locService = await locationCache.get(userId);
        const deleted = locService.deleteLocationByName(name);

        if (!deleted) {
          return toolError(`"${name}" bulunamadı`, new Error("Konum mevcut değil"));
        }

        console.log(`[Location] Deleted "${name}" for user ${userId}`);
        return toolSuccess(`Konum "${name}" silindi.`);
      } catch (error) {
        return toolError("Konum silinemedi", error);
      }
    }
  );

// ========== DISTANCE & ROUTE ==========

export const getDistanceTool = (userId: number) =>
  tool(
    "get_distance",
    "İki konum arası mesafe ve süre hesapla (gerçek zamanlı trafik dahil). Kayıtlı konum adı, koordinat veya adres kullanılabilir.",
    {
      origin: z.string().describe("Başlangıç: kayıtlı konum adı veya adres"),
      destination: z.string().describe("Varış: kayıtlı konum adı veya adres"),
      travelMode: z
        .enum(["DRIVE", "WALK", "BICYCLE", "TRANSIT"])
        .default("DRIVE")
        .describe("Ulaşım modu"),
    },
    async ({ origin, destination, travelMode }) => {
      try {
        const locService = await locationCache.get(userId);

        // Resolve origin
        const originCoords = await resolveLocation(locService, origin);
        if (!originCoords) {
          return toolError("Başlangıç bulunamadı", new Error(`"${origin}" çözümlenemedi`));
        }

        // Resolve destination
        const destCoords = await resolveLocation(locService, destination);
        if (!destCoords) {
          return toolError("Varış bulunamadı", new Error(`"${destination}" çözümlenemedi`));
        }

        const result = await locService.getDistance(
          originCoords.lat,
          originCoords.lng,
          destCoords.lat,
          destCoords.lng,
          travelMode
        );

        if (!result) {
          return toolError("Rota bulunamadı", new Error("Google Routes API sonuç döndürmedi"));
        }

        const modeText: Record<string, string> = {
          DRIVE: "Arabayla",
          WALK: "Yürüyerek",
          BICYCLE: "Bisikletle",
          TRANSIT: "Toplu taşımayla",
        };

        const parts = [
          `${originCoords.name} → ${destCoords.name}`,
          `${modeText[travelMode]}: ${result.distanceText}, ${result.durationText}`,
        ];

        if (result.durationInTrafficText && travelMode === "DRIVE") {
          parts.push(`Trafikle: ${result.durationInTrafficText}`);
        }

        return toolSuccess(parts.join("\n"));
      } catch (error) {
        return toolError("Mesafe hesaplanamadı", error);
      }
    }
  );

// ========== GEOCODE ==========

export const geocodeTool = (userId: number) =>
  tool(
    "geocode",
    "Adres veya yer adını koordinata çevir (geocoding). Ya da koordinatı adrese çevir (reverse geocoding).",
    {
      address: z.string().optional().describe("Adres veya yer adı (geocode)"),
      latitude: z.number().optional().describe("Enlem (reverse geocode)"),
      longitude: z.number().optional().describe("Boylam (reverse geocode)"),
    },
    async ({ address, latitude, longitude }) => {
      try {
        const locService = await locationCache.get(userId);

        // Reverse geocode
        if (latitude !== undefined && longitude !== undefined) {
          const result = await locService.reverseGeocode(latitude, longitude);
          if (!result) {
            return toolError("Adres bulunamadı", new Error("Reverse geocode sonuç döndürmedi"));
          }
          return toolSuccess(
            `Koordinat: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}\nAdres: ${result.formattedAddress}`
          );
        }

        // Forward geocode
        if (address) {
          const result = await locService.geocode(address);
          if (!result) {
            return toolError("Konum bulunamadı", new Error(`"${address}" geocode edilemedi`));
          }
          return toolSuccess(
            `Adres: ${result.formattedAddress}\nKoordinat: ${result.latitude.toFixed(6)}, ${result.longitude.toFixed(6)}\nPlace ID: ${result.placeId}`
          );
        }

        return toolError(
          "Parametre gerekli",
          new Error("address veya latitude+longitude belirtilmeli")
        );
      } catch (error) {
        return toolError("Geocode hatası", error);
      }
    }
  );

// ========== HELPER ==========

interface ResolvedLocation {
  name: string;
  lat: number;
  lng: number;
}

/**
 * Resolve location from saved name, coordinates, or address
 */
async function resolveLocation(
  service: LocationService,
  input: string
): Promise<ResolvedLocation | null> {
  // 1. Kayıtlı konum adıyla ara
  const saved = service.getLocationByName(input);
  if (saved) {
    return { name: saved.name, lat: saved.latitude, lng: saved.longitude };
  }

  // 2. Koordinat formatı: "41.0082,28.9784" veya "41.0082, 28.9784"
  const coordMatch = input.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { name: `${lat.toFixed(4)},${lng.toFixed(4)}`, lat, lng };
    }
  }

  // 3. Adres olarak geocode et
  try {
    const geocoded = await service.geocode(input);
    if (geocoded) {
      return {
        name: geocoded.formattedAddress,
        lat: geocoded.latitude,
        lng: geocoded.longitude,
      };
    }
  } catch {
    // geocode hatası varsa null dön
  }

  return null;
}

// ========== MCP SERVER ==========

/**
 * Create Location MCP server for a specific user
 */
export function createLocationServer(userId: number) {
  return createSdkMcpServer({
    name: "cobrain-location",
    version: "1.0.0",
    tools: [
      getUserLocationTool(userId),
      saveLocationTool(userId),
      listLocationsTool(userId),
      deleteLocationTool(userId),
      getDistanceTool(userId),
      geocodeTool(userId),
    ],
  });
}

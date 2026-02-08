/**
 * Location Service
 * Konum kaydetme, geocoding ve mesafe/süre hesaplama
 * Google Maps Routes API + Geocoding API kullanır
 */

import type { Database } from "bun:sqlite";

// ========== Types ==========

export interface SavedLocation {
  id: number;
  name: string;
  label: string; // ev, iş, park, favori, özel
  latitude: number;
  longitude: number;
  address: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationInput {
  name: string;
  label?: string;
  latitude: number;
  longitude: number;
  address?: string;
  notes?: string;
}

export interface DistanceResult {
  originName: string;
  destinationName: string;
  distanceMeters: number;
  distanceText: string;
  durationSeconds: number;
  durationText: string;
  durationInTrafficSeconds?: number;
  durationInTrafficText?: string;
  polyline?: string;
}

export interface GeocodeResult {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  placeId: string;
  types: string[];
}

export interface ReverseGeocodeResult {
  formattedAddress: string;
  placeId: string;
  components: Record<string, string>;
}

// DB row type
interface LocationDbRow {
  id: number;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  address: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ========== Service ==========

export class LocationService {
  private db: Database;
  private apiKey: string;

  constructor(userDb: Database) {
    this.db = userDb;
    this.apiKey = process.env.GOOGLE_MAPS_API_KEY || "";
    this.initTables();
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        label TEXT DEFAULT 'özel',
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        address TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Unique constraint on name
    try {
      this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_name ON locations(name)`);
    } catch { /* already exists */ }
  }

  // ========== CRUD ==========

  saveLocation(input: LocationInput): SavedLocation {
    // Upsert - if name exists, update it
    const existing = this.getLocationByName(input.name);

    if (existing) {
      this.db.run(
        `UPDATE locations SET latitude = ?, longitude = ?, address = ?, label = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          input.latitude,
          input.longitude,
          input.address ?? existing.address,
          input.label ?? existing.label,
          input.notes ?? existing.notes,
          existing.id,
        ]
      );
      return this.getLocation(existing.id)!;
    }

    const result = this.db.run(
      `INSERT INTO locations (name, label, latitude, longitude, address, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.label ?? "özel",
        input.latitude,
        input.longitude,
        input.address ?? null,
        input.notes ?? null,
      ]
    );

    return this.getLocation(Number(result.lastInsertRowid))!;
  }

  getLocation(id: number): SavedLocation | null {
    const row = this.db
      .query<LocationDbRow, [number]>("SELECT * FROM locations WHERE id = ?")
      .get(id);
    return row ? this.mapRow(row) : null;
  }

  getLocationByName(name: string): SavedLocation | null {
    const row = this.db
      .query<LocationDbRow, [string]>(
        "SELECT * FROM locations WHERE LOWER(name) = LOWER(?)"
      )
      .get(name);
    return row ? this.mapRow(row) : null;
  }

  getAllLocations(): SavedLocation[] {
    const rows = this.db
      .query<LocationDbRow, []>("SELECT * FROM locations ORDER BY label, name")
      .all();
    return rows.map(this.mapRow);
  }

  deleteLocation(id: number): boolean {
    const result = this.db.run("DELETE FROM locations WHERE id = ?", [id]);
    return (result.changes ?? 0) > 0;
  }

  deleteLocationByName(name: string): boolean {
    const result = this.db.run(
      "DELETE FROM locations WHERE LOWER(name) = LOWER(?)",
      [name]
    );
    return (result.changes ?? 0) > 0;
  }

  // ========== Google Maps API ==========

  /**
   * Geocode: Adres -> Koordinat
   */
  async geocode(address: string): Promise<GeocodeResult | null> {
    if (!this.apiKey) throw new Error("GOOGLE_MAPS_API_KEY ayarlanmamış");

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("language", "tr");

    const res = await fetch(url.toString());
    const data = (await res.json()) as {
      status: string;
      results: Array<{
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
        place_id: string;
        types: string[];
      }>;
    };

    if (data.status !== "OK" || !data.results.length) {
      return null;
    }

    const result = data.results[0];
    return {
      formattedAddress: result.formatted_address,
      latitude: result.geometry.location.lat,
      longitude: result.geometry.location.lng,
      placeId: result.place_id,
      types: result.types,
    };
  }

  /**
   * Reverse Geocode: Koordinat -> Adres
   */
  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult | null> {
    if (!this.apiKey) throw new Error("GOOGLE_MAPS_API_KEY ayarlanmamış");

    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng", `${lat},${lng}`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("language", "tr");

    const res = await fetch(url.toString());
    const data = (await res.json()) as {
      status: string;
      results: Array<{
        formatted_address: string;
        place_id: string;
        address_components: Array<{
          long_name: string;
          types: string[];
        }>;
      }>;
    };

    if (data.status !== "OK" || !data.results.length) {
      return null;
    }

    const result = data.results[0];
    const components: Record<string, string> = {};
    for (const comp of result.address_components) {
      for (const type of comp.types) {
        components[type] = comp.long_name;
      }
    }

    return {
      formattedAddress: result.formatted_address,
      placeId: result.place_id,
      components,
    };
  }

  /**
   * Routes API: İki nokta arası mesafe ve süre (trafik dahil)
   */
  async getDistance(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number,
    travelMode: "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT" = "DRIVE"
  ): Promise<DistanceResult | null> {
    if (!this.apiKey) throw new Error("GOOGLE_MAPS_API_KEY ayarlanmamış");

    const body = {
      origin: {
        location: {
          latLng: { latitude: originLat, longitude: originLng },
        },
      },
      destination: {
        location: {
          latLng: { latitude: destLat, longitude: destLng },
        },
      },
      travelMode,
      routingPreference: travelMode === "DRIVE" ? "TRAFFIC_AWARE" : undefined,
      computeAlternativeRoutes: false,
      languageCode: "tr",
      units: "METRIC",
    };

    const res = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask":
            "routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline",
        },
        body: JSON.stringify(body),
      }
    );

    const data = (await res.json()) as {
      routes?: Array<{
        distanceMeters: number;
        duration: string; // "1234s" format
        staticDuration?: string;
        polyline?: { encodedPolyline: string };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`Routes API: ${data.error.message}`);
    }

    if (!data.routes?.length) {
      return null;
    }

    const route = data.routes[0];
    const distanceMeters = route.distanceMeters;
    const durationSeconds = parseInt(route.duration.replace("s", ""));
    const staticDurationSeconds = route.staticDuration
      ? parseInt(route.staticDuration.replace("s", ""))
      : undefined;

    return {
      originName: `${originLat.toFixed(4)},${originLng.toFixed(4)}`,
      destinationName: `${destLat.toFixed(4)},${destLng.toFixed(4)}`,
      distanceMeters,
      distanceText: formatDistance(distanceMeters),
      durationSeconds,
      durationText: formatDuration(durationSeconds),
      durationInTrafficSeconds:
        durationSeconds !== staticDurationSeconds ? durationSeconds : undefined,
      durationInTrafficText:
        durationSeconds !== staticDurationSeconds
          ? formatDuration(durationSeconds)
          : undefined,
      polyline: route.polyline?.encodedPolyline,
    };
  }

  /**
   * Kayıtlı iki konum arası mesafe
   */
  async getDistanceBetweenLocations(
    originName: string,
    destName: string,
    travelMode: "DRIVE" | "WALK" | "BICYCLE" | "TRANSIT" = "DRIVE"
  ): Promise<DistanceResult | null> {
    const origin = this.getLocationByName(originName);
    const dest = this.getLocationByName(destName);

    if (!origin) throw new Error(`"${originName}" konumu bulunamadı`);
    if (!dest) throw new Error(`"${destName}" konumu bulunamadı`);

    const result = await this.getDistance(
      origin.latitude,
      origin.longitude,
      dest.latitude,
      dest.longitude,
      travelMode
    );

    if (result) {
      result.originName = origin.name;
      result.destinationName = dest.name;
    }

    return result;
  }

  // ========== Private ==========

  private mapRow(row: LocationDbRow): SavedLocation {
    return {
      id: row.id,
      name: row.name,
      label: row.label,
      latitude: row.latitude,
      longitude: row.longitude,
      address: row.address,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ========== Helpers ==========

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${meters} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} saniye`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (hours === 0) {
    return `${mins} dakika`;
  }
  if (mins === 0) {
    return `${hours} saat`;
  }
  return `${hours} saat ${mins} dakika`;
}

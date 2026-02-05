/**
 * Phone Agent Service
 * Manages connected phone(s) via Termux-API
 */

import { config } from "../config.ts";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

interface PhoneDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
  lastSeen: number;
  capabilities: string[];
}

interface PhoneMedia {
  type: "photo" | "audio" | "video";
  filename: string;
  path: string;
  timestamp: number;
  deviceId: string;
}

// Connected phones
const phones = new Map<string, PhoneDevice>();

// Media storage path
const MEDIA_PATH = join(config.COBRAIN_BASE_PATH, "phone-media");

/**
 * Initialize phone agent service
 */
export async function initPhoneAgent(): Promise<void> {
  // Ensure media directory exists
  await mkdir(MEDIA_PATH, { recursive: true });
  console.log("[Phone] Agent service initialized");
}

/**
 * Register a phone device
 */
export function registerPhone(
  id: string,
  name: string,
  ip: string,
  port: number,
  capabilities: string[] = ["camera", "microphone", "location"]
): PhoneDevice {
  const device: PhoneDevice = {
    id,
    name,
    ip,
    port,
    lastSeen: Date.now(),
    capabilities,
  };
  phones.set(id, device);
  console.log(`[Phone] Registered: ${name} (${ip}:${port})`);
  return device;
}

/**
 * Update phone last seen timestamp
 */
export function phoneHeartbeat(id: string): boolean {
  const phone = phones.get(id);
  if (phone) {
    phone.lastSeen = Date.now();
    return true;
  }
  return false;
}

/**
 * Get all connected phones
 */
export function getPhones(): PhoneDevice[] {
  return Array.from(phones.values());
}

/**
 * Get a specific phone
 */
export function getPhone(id: string): PhoneDevice | undefined {
  return phones.get(id);
}

/**
 * Check if phone is online (seen in last 60 seconds)
 */
export function isPhoneOnline(id: string): boolean {
  const phone = phones.get(id);
  if (!phone) return false;
  return Date.now() - phone.lastSeen < 60_000;
}

/**
 * Send command to phone
 */
export async function sendPhoneCommand(
  id: string,
  command: "photo" | "audio" | "location" | "battery" | "info",
  params?: Record<string, unknown>
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  const phone = phones.get(id);
  if (!phone) {
    return { success: false, error: "Phone not found" };
  }

  if (!isPhoneOnline(id)) {
    return { success: false, error: "Phone is offline" };
  }

  try {
    const response = await fetch(`http://${phone.ip}:${phone.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, params }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Save media from phone
 */
export async function savePhoneMedia(
  deviceId: string,
  type: "photo" | "audio" | "video",
  data: ArrayBuffer | Uint8Array
): Promise<PhoneMedia> {
  const timestamp = Date.now();
  const ext = type === "photo" ? "jpg" : type === "audio" ? "wav" : "mp4";
  const filename = `${deviceId}_${timestamp}.${ext}`;
  const path = join(MEDIA_PATH, filename);

  await Bun.write(path, data);

  const media: PhoneMedia = {
    type,
    filename,
    path,
    timestamp,
    deviceId,
  };

  console.log(`[Phone] Saved ${type}: ${filename}`);
  return media;
}

/**
 * Get recent media from a phone
 */
export async function getPhoneMedia(
  deviceId?: string,
  type?: "photo" | "audio" | "video",
  limit: number = 10
): Promise<PhoneMedia[]> {
  const glob = new Bun.Glob("*.*");
  const files: PhoneMedia[] = [];

  for await (const file of glob.scan(MEDIA_PATH)) {
    const parts = file.split("_");
    if (parts.length < 2) continue;

    const fileDeviceId = parts[0] ?? "unknown";
    const ext = file.split(".").pop();
    const fileType =
      ext === "jpg" || ext === "png"
        ? "photo"
        : ext === "wav" || ext === "mp3"
          ? "audio"
          : "video";

    // Filter by device and type
    if (deviceId && fileDeviceId !== deviceId) continue;
    if (type && fileType !== type) continue;

    const stat = await Bun.file(join(MEDIA_PATH, file)).stat();

    files.push({
      type: fileType,
      filename: file,
      path: join(MEDIA_PATH, file),
      timestamp: stat?.mtime?.getTime() ?? 0,
      deviceId: fileDeviceId,
    });
  }

  // Sort by timestamp descending and limit
  return files.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/**
 * Request photo from phone
 */
export async function requestPhoto(
  phoneId: string,
  camera: "front" | "back" = "front"
): Promise<{ success: boolean; path?: string; error?: string }> {
  const result = await sendPhoneCommand(phoneId, "photo", { camera });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // If phone sends back the image data directly
  if (result.data && typeof result.data === "object" && "image" in result.data) {
    const imageData = result.data.image as string;
    const buffer = Buffer.from(imageData, "base64");
    const media = await savePhoneMedia(phoneId, "photo", buffer);
    return { success: true, path: media.path };
  }

  return { success: true };
}

/**
 * Request audio recording from phone
 */
export async function requestAudio(
  phoneId: string,
  duration: number = 5
): Promise<{ success: boolean; path?: string; error?: string }> {
  const result = await sendPhoneCommand(phoneId, "audio", { duration });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true };
}

/**
 * Request location from phone
 */
export async function requestLocation(
  phoneId: string
): Promise<{ success: boolean; location?: { lat: number; lon: number }; error?: string }> {
  const result = await sendPhoneCommand(phoneId, "location");

  if (!result.success) {
    return { success: false, error: result.error };
  }

  if (result.data && typeof result.data === "object") {
    return { success: true, location: result.data as { lat: number; lon: number } };
  }

  return { success: false, error: "Invalid location data" };
}

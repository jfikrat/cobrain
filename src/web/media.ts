/**
 * Media Upload & Transcription Handler
 * Handles file uploads from mobile clients
 */

import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateToken } from "./auth.ts";
import { userManager } from "../services/user-manager.ts";
import { transcribeAudio } from "../services/transcribe.ts";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"];
const ALLOWED_AUDIO_TYPES = ["audio/m4a", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-m4a", "audio/aac"];

interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
}

/**
 * Get the uploads directory for a user, creating it if needed
 */
function getUploadsDir(userId: number): string {
  const userFolder = userManager.getUserFolder(userId);
  const uploadsDir = join(userFolder, "uploads");
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }
  return uploadsDir;
}

/**
 * Handle POST /api/media/upload
 */
export async function handleMediaUpload(req: Request): Promise<Response> {
  // Auth
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = validateToken(authHeader.slice(7));
  if (!userId) {
    return Response.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, { status: 400 });
    }

    // Validate type
    const mimeType = file.type || "application/octet-stream";
    const isImage = ALLOWED_IMAGE_TYPES.includes(mimeType);
    const isAudio = ALLOWED_AUDIO_TYPES.includes(mimeType);

    if (!isImage && !isAudio) {
      return Response.json({ error: `Unsupported file type: ${mimeType}` }, { status: 400 });
    }

    // Generate unique ID and save file
    const id = randomUUID();
    const ext = file.name?.split(".").pop() || (isImage ? "jpg" : "m4a");
    const filename = `${id}.${ext}`;
    const uploadsDir = getUploadsDir(userId);
    const filePath = join(uploadsDir, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await Bun.write(filePath, buffer);

    const result: UploadedFile = {
      id,
      filename,
      mimeType,
      size: file.size,
      path: filePath,
    };

    console.log(`[Media] Uploaded ${mimeType} (${(file.size / 1024).toFixed(1)}KB) for user ${userId}: ${id}`);

    return Response.json({
      id: result.id,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      url: `/api/media/${result.id}`,
    });
  } catch (err) {
    console.error("[Media] Upload error:", err);
    const msg = err instanceof Error ? err.message : "Upload failed";
    return Response.json({ error: msg }, { status: 500 });
  }
}

/**
 * Handle POST /api/media/transcribe
 */
export async function handleMediaTranscribe(req: Request): Promise<Response> {
  // Auth
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = validateToken(authHeader.slice(7));
  if (!userId) {
    return Response.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { attachmentId } = body as { attachmentId: string };

    if (!attachmentId) {
      return Response.json({ error: "attachmentId required" }, { status: 400 });
    }

    // Find the file
    const uploadsDir = getUploadsDir(userId);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(uploadsDir);
    const matchingFile = files.find((f) => f.startsWith(attachmentId));

    if (!matchingFile) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const filePath = join(uploadsDir, matchingFile);
    const fileBuffer = Buffer.from(await Bun.file(filePath).arrayBuffer());

    // Determine mime type from extension
    const ext = matchingFile.split(".").pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      m4a: "audio/mp4",
      mp4: "audio/mp4",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      wav: "audio/wav",
      aac: "audio/aac",
    };
    const mimeType = mimeMap[ext || ""] || "audio/mp4";

    const transcript = await transcribeAudio(fileBuffer, mimeType);

    console.log(`[Media] Transcribed ${attachmentId} for user ${userId}: "${transcript.slice(0, 50)}..."`);

    return Response.json({ transcript });
  } catch (err) {
    console.error("[Media] Transcribe error:", err);
    const msg = err instanceof Error ? err.message : "Transcription failed";
    return Response.json({ error: msg }, { status: 500 });
  }
}

/**
 * Handle GET /api/media/:id — Serve uploaded file
 */
export async function handleMediaServe(req: Request, attachmentId: string): Promise<Response> {
  // Auth from query param or header
  const url = new URL(req.url);
  const tokenParam = url.searchParams.get("token");
  const authHeader = req.headers.get("authorization");
  const token = tokenParam || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = validateToken(token);
  if (!userId) {
    return Response.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  try {
    const uploadsDir = getUploadsDir(userId);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(uploadsDir);
    const matchingFile = files.find((f) => f.startsWith(attachmentId));

    if (!matchingFile) {
      return new Response("Not found", { status: 404 });
    }

    const filePath = join(uploadsDir, matchingFile);
    const file = Bun.file(filePath);

    return new Response(file, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/**
 * Embedding Service - Gemini text-embedding-004 for vector search
 * Cobrain v1.2
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.ts";

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
  if (genAI) return genAI;

  const key = config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!key) {
    console.warn("[Embedding] GEMINI_API_KEY not configured");
    return null;
  }

  genAI = new GoogleGenerativeAI(key);
  return genAI;
}

export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const model = client.getGenerativeModel({ model: config.EMBEDDING_MODEL });
    const result = await model.embedContent(text);
    return new Float32Array(result.embedding.values);
  } catch (err) {
    console.warn("[Embedding] generateEmbedding failed:", err);
    return null;
  }
}

export async function generateEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  const client = getClient();
  if (!client) return texts.map(() => null);

  try {
    const model = client.getGenerativeModel({ model: config.EMBEDDING_MODEL });
    const result = await model.batchEmbedContents({
      requests: texts.map((text) => ({
        content: { role: "user", parts: [{ text }] },
      })),
    });

    return result.embeddings.map((e) => new Float32Array(e.values));
  } catch (err) {
    console.warn("[Embedding] generateEmbeddings batch failed:", err);
    return texts.map(() => null);
  }
}

export function chunkText(
  text: string,
  chunkSize: number = config.CHUNK_SIZE,
  overlap: number = config.CHUNK_OVERLAP
): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
}

/**
 * Embedding generation using Ollama
 * Cobrain v0.2
 */

import { config } from "../config.ts";

export interface EmbeddingResult {
  embedding: Float32Array;
  model: string;
  promptTokens: number;
}

export interface OllamaEmbeddingResponse {
  embedding: number[];
  model: string;
  prompt_eval_count?: number;
}

let ollamaAvailable: boolean | null = null;

/**
 * Check if Ollama is available
 */
export async function checkOllamaStatus(): Promise<boolean> {
  if (ollamaAvailable !== null) return ollamaAvailable;

  try {
    const response = await fetch(`${config.OLLAMA_URL}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      ollamaAvailable = false;
      return false;
    }

    const data = (await response.json()) as { models?: { name: string }[] };
    const models = data.models || [];
    const hasModel = models.some((m) => m.name.includes(config.EMBEDDING_MODEL.split(":")[0] ?? ""));

    if (!hasModel) {
      console.warn(`[Embeddings] Model ${config.EMBEDDING_MODEL} not found in Ollama`);
      console.warn(`[Embeddings] Available models: ${models.map((m) => m.name).join(", ")}`);
    }

    ollamaAvailable = true;
    return true;
  } catch (error) {
    console.warn(`[Embeddings] Ollama not available at ${config.OLLAMA_URL}`);
    ollamaAvailable = false;
    return false;
  }
}

/**
 * Generate embedding for text using Ollama
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const available = await checkOllamaStatus();

  if (!available) {
    throw new Error("Ollama is not available. Please ensure Ollama is running.");
  }

  // Truncate very long texts to avoid issues
  const truncatedText = text.slice(0, 8000);

  const response = await fetch(`${config.OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.EMBEDDING_MODEL,
      prompt: truncatedText,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embedding error: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as OllamaEmbeddingResponse;

  if (!data.embedding || data.embedding.length === 0) {
    throw new Error("Ollama returned empty embedding");
  }

  // Verify dimension
  if (data.embedding.length !== config.EMBEDDING_DIMENSION) {
    console.warn(
      `[Embeddings] Dimension mismatch: expected ${config.EMBEDDING_DIMENSION}, got ${data.embedding.length}`
    );
  }

  return {
    embedding: new Float32Array(data.embedding),
    model: data.model,
    promptTokens: data.prompt_eval_count ?? 0,
  };
}

/**
 * Generate embeddings for multiple texts (batched)
 */
export async function generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  // Ollama doesn't support batch embedding, so we do it sequentially
  // Could be parallelized but might overwhelm the server
  const results: EmbeddingResult[] = [];

  for (const text of texts) {
    try {
      const result = await generateEmbedding(text);
      results.push(result);
    } catch (error) {
      console.error(`[Embeddings] Failed to embed text: ${text.slice(0, 50)}...`);
      throw error;
    }
  }

  return results;
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Reset Ollama availability cache (for testing)
 */
export function resetOllamaCache(): void {
  ollamaAvailable = null;
}

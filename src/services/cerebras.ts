/**
 * Cerebras API Client
 * Ultra-fast LLM inference for memory operations
 * Cobrain v0.2
 */

const CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions";

export interface CerebrasConfig {
  apiKey: string;
  model: string;
}

export interface CerebrasMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CerebrasResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

let config: CerebrasConfig | null = null;

/**
 * Initialize Cerebras client
 */
export function initCerebras(apiKey?: string, model?: string): boolean {
  const key = apiKey || process.env.CEREBRAS_API_KEY;

  if (!key) {
    console.warn("[Cerebras] API key not configured");
    return false;
  }

  config = {
    apiKey: key,
    model: model || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
  };

  console.log(`[Cerebras] Initialized with model: ${config.model}`);
  return true;
}

/**
 * Check if Cerebras is available
 */
export function isCerebrasAvailable(): boolean {
  return config !== null;
}

/**
 * Send a chat completion request to Cerebras
 */
export async function chat(
  messages: CerebrasMessage[],
  options?: { temperature?: number; maxTokens?: number }
): Promise<CerebrasResponse> {
  if (!config) {
    throw new Error("Cerebras not initialized. Call initCerebras() first.");
  }

  const response = await fetch(CEREBRAS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.maxTokens ?? 500,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cerebras API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as {
    choices: { message: { content: string } }[];
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };

  return {
    content: data.choices[0]?.message?.content || "",
    model: data.model,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}

/**
 * Quick one-shot completion
 */
export async function complete(prompt: string, systemPrompt?: string): Promise<string> {
  const messages: CerebrasMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  const response = await chat(messages);
  return response.content;
}

/**
 * Extract keywords/tags from text
 */
export async function extractTags(text: string): Promise<string[]> {
  const prompt = `Metinden en önemli 3-5 anahtar kelimeyi çıkar. Sadece virgülle ayrılmış kelimeler yaz, başka bir şey yazma.

Metin: "${text}"

Anahtar kelimeler:`;

  const response = await complete(prompt);

  return response
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length < 50);
}

/**
 * Generate a summary of text
 */
export async function summarize(text: string, maxWords: number = 20): Promise<string> {
  const prompt = `Bu metni maksimum ${maxWords} kelimeyle özetle. Sadece özeti yaz.

Metin: "${text}"

Özet:`;

  return (await complete(prompt)).trim();
}

/**
 * Check if a memory is relevant to a query (semantic matching)
 */
export async function isRelevant(
  query: string,
  memoryContent: string,
  threshold: number = 0.6
): Promise<{ relevant: boolean; score: number; reason: string }> {
  const prompt = `Bir hafıza kaydının bir sorguyla ne kadar alakalı olduğunu değerlendir.

Sorgu: "${query}"
Hafıza: "${memoryContent}"

0-100 arası bir puan ver ve kısa açıkla. Format:
PUAN: [sayı]
NEDEN: [açıklama]`;

  const response = await complete(prompt);

  const scoreMatch = response.match(/PUAN:\s*(\d+)/i);
  const reasonMatch = response.match(/NEDEN:\s*(.+)/i);

  const score = scoreMatch ? parseInt(scoreMatch[1]!, 10) / 100 : 0;
  const reason = reasonMatch ? reasonMatch[1]!.trim() : "";

  return {
    relevant: score >= threshold,
    score,
    reason,
  };
}

/**
 * Rank memories by relevance to a query
 */
export async function rankMemories(
  query: string,
  memories: { id: number; content: string; summary?: string }[],
  limit: number = 5
): Promise<{ id: number; score: number }[]> {
  if (memories.length === 0) return [];

  // For small lists, check each one
  if (memories.length <= 10) {
    const results: { id: number; score: number }[] = [];

    for (const memory of memories) {
      const text = memory.summary || memory.content.slice(0, 200);
      const { score } = await isRelevant(query, text);
      results.push({ id: memory.id, score });
    }

    return results
      .filter((r) => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // For larger lists, use batch evaluation
  const memoriesText = memories
    .slice(0, 20) // Limit to 20 for batch
    .map((m, i) => `${i + 1}. ${m.summary || m.content.slice(0, 100)}`)
    .join("\n");

  const prompt = `Sorgu: "${query}"

Hafızalar:
${memoriesText}

En alakalı ${limit} hafızanın numaralarını ve puanlarını (0-100) ver.
Format: NUMARA:PUAN (her satırda bir tane)`;

  const response = await complete(prompt);

  const results: { id: number; score: number }[] = [];
  const lines = response.split("\n");

  for (const line of lines) {
    const match = line.match(/(\d+)[:\s]+(\d+)/);
    if (match) {
      const index = parseInt(match[1]!, 10) - 1;
      const score = parseInt(match[2]!, 10) / 100;

      if (index >= 0 && index < memories.length && memories[index]) {
        results.push({ id: memories[index]!.id, score });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

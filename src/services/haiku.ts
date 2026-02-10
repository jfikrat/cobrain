/**
 * Haiku Service - Claude Haiku for memory operations
 * Replaces Cerebras for tag extraction and semantic ranking
 * Cobrain v0.3
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20250121";

let apiKey: string | null = null;

/**
 * Initialize Haiku client
 */
export function initHaiku(): boolean {
  apiKey = process.env.ANTHROPIC_API_KEY || null;

  if (!apiKey) {
    console.warn("[Haiku] ANTHROPIC_API_KEY not configured");
    return false;
  }

  console.log(`[Haiku] Initialized with model: ${HAIKU_MODEL}`);
  return true;
}

/**
 * Check if Haiku is available
 */
export function isHaikuAvailable(): boolean {
  if (apiKey) return true;

  // Try to initialize on first check
  return initHaiku();
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Quick completion helper
 */
async function complete(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 200
): Promise<string> {
  if (!apiKey) {
    throw new Error("Haiku not initialized. Call initHaiku() first.");
  }

  const messages: AnthropicMessage[] = [{ role: "user", content: prompt }];

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as AnthropicResponse;
  const textBlock = data.content.find((block) => block.type === "text");
  return textBlock?.text || "";
}

/**
 * Extract keywords/tags from text
 */
export async function extractTags(text: string): Promise<string[]> {
  const systemPrompt =
    "Sen bir anahtar kelime çıkarma asistanısın. Sadece virgülle ayrılmış kelimeler yaz, başka bir şey yazma.";

  const prompt = `Metinden en önemli 3-5 anahtar kelimeyi çıkar.

Metin: "${text}"

Anahtar kelimeler:`;

  const response = await complete(prompt, systemPrompt, 100);

  return response
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length < 50);
}

/**
 * Generate a summary of text
 */
export async function summarize(
  text: string,
  maxWords: number = 20
): Promise<string> {
  const systemPrompt = "Sen bir özetleme asistanısın. Sadece özeti yaz.";

  const prompt = `Bu metni maksimum ${maxWords} kelimeyle özetle.

Metin: "${text}"

Özet:`;

  return (await complete(prompt, systemPrompt, 100)).trim();
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

  // For small lists (<=10), use individual scoring
  if (memories.length <= 10) {
    return rankIndividually(query, memories, limit);
  }

  // For larger lists, use batch evaluation
  return rankBatch(query, memories, limit);
}

/**
 * Score each memory individually
 */
async function rankIndividually(
  query: string,
  memories: { id: number; content: string; summary?: string }[],
  limit: number
): Promise<{ id: number; score: number }[]> {
  const results: { id: number; score: number }[] = [];

  for (const memory of memories) {
    const text = memory.summary || memory.content.slice(0, 200);
    const score = await scoreRelevance(query, text);
    results.push({ id: memory.id, score });
  }

  return results
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Score a single memory's relevance to a query
 */
async function scoreRelevance(
  query: string,
  memoryContent: string
): Promise<number> {
  const systemPrompt =
    "Sen bir ilgi değerlendirme asistanısın. Sadece 0-100 arası bir sayı yaz.";

  const prompt = `Sorgu: "${query}"
Hafıza: "${memoryContent}"

Bu hafızanın sorguyla ne kadar alakalı olduğunu 0-100 arası bir sayı ile değerlendir:`;

  const response = await complete(prompt, systemPrompt, 20);
  const match = response.match(/(\d+)/);

  if (match && match[1]) {
    return parseInt(match[1], 10) / 100;
  }

  return 0;
}

/**
 * Batch evaluate memories for efficiency
 */
async function rankBatch(
  query: string,
  memories: { id: number; content: string; summary?: string }[],
  limit: number
): Promise<{ id: number; score: number }[]> {
  const memoriesText = memories
    .slice(0, 20) // Limit to 20 for batch
    .map((m, i) => `${i + 1}. ${m.summary || m.content.slice(0, 100)}`)
    .join("\n");

  const systemPrompt =
    "Sen bir hafıza sıralama asistanısın. Her satırda NUMARA:PUAN formatında yaz.";

  const prompt = `Sorgu: "${query}"

Hafızalar:
${memoriesText}

En alakalı ${limit} hafızanın numaralarını ve puanlarını (0-100) ver.
Format: NUMARA:PUAN (her satırda bir tane)`;

  const response = await complete(prompt, systemPrompt, 200);

  const results: { id: number; score: number }[] = [];
  const lines = response.split("\n");

  for (const line of lines) {
    const match = line.match(/(\d+)[:\s]+(\d+)/);
    if (match && match[1] && match[2]) {
      const index = parseInt(match[1], 10) - 1;
      const score = parseInt(match[2], 10) / 100;

      if (index >= 0 && index < memories.length && memories[index]) {
        results.push({ id: memories[index]!.id, score });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ========== WhatsApp Tier Classification ==========

export interface TierClassification {
  tier: 1 | 2 | 3;
  reason: string;
  reply?: string;
  suggestedReply?: string;
}

export interface GroupClassification {
  shouldReply: boolean;
  reason: string;
  reply?: string;
  notifyUser: string;
}

/**
 * Classify WhatsApp message tier using Haiku (~25x cheaper than Opus)
 */
export async function classifyWhatsAppMessage(
  senderName: string,
  messages: string,
  context: "dm" | "group",
  groupName?: string
): Promise<TierClassification | GroupClassification> {
  if (context === "dm") {
    const prompt = `WhatsApp DM analizi. "${senderName}" mesaj göndermiş:

${messages}

Karar ver:
TIER 1 (otomatik cevapla): Selamlasma, "musait misin?", tesekkur
TIER 2 (kullaniciya bildir + öneri): Soru, randevu, önemli konu
TIER 3 (sadece bildir): Medya, belirsiz, bilinmeyen konu

KURALLAR: Sen Cobrain, Fekrat'ın asistanı. Samimi ama kısa yaz.

JSON döndür:
{"tier": 1|2|3, "reason": "kısa", "reply": "tier1 cevap", "suggestedReply": "tier2 öneri"}`;

    const systemPrompt = "WhatsApp mesaj sınıflandırıcısın. SADECE geçerli JSON döndür, başka bir şey yazma.";
    const raw = await complete(prompt, systemPrompt, 300);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { tier: 3, reason: "parse_error" };
    }
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        tier: [1, 2, 3].includes(parsed.tier) ? parsed.tier : 3,
        reason: String(parsed.reason || ""),
        reply: parsed.reply ? String(parsed.reply) : undefined,
        suggestedReply: parsed.suggestedReply ? String(parsed.suggestedReply) : undefined,
      };
    } catch {
      return { tier: 3, reason: "json_parse_error" };
    }
  } else {
    const prompt = `WhatsApp grup analizi. "${groupName}" grubunda mesajlar:

${messages}

Fekrat'a yönelik mi? Cevap vermeli mi?

KURALLAR: Aile grubu, samimi ol. Emin değilsen CEVAP VERME.

JSON döndür:
{"shouldReply": true/false, "reason": "kısa", "reply": "cevap", "notifyUser": "Telegram bildirimi"}`;

    const systemPrompt = "WhatsApp grup mesaj analizcisisin. SADECE geçerli JSON döndür.";
    const raw = await complete(prompt, systemPrompt, 300);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { shouldReply: false, reason: "parse_error", notifyUser: "" };
    }
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        shouldReply: Boolean(parsed.shouldReply),
        reason: String(parsed.reason || ""),
        reply: parsed.reply ? String(parsed.reply) : undefined,
        notifyUser: String(parsed.notifyUser || ""),
      };
    } catch {
      return { shouldReply: false, reason: "json_parse_error", notifyUser: "" };
    }
  }
}

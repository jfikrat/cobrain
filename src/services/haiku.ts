/**
 * Haiku Service - LLM helper for memory operations
 * Uses Gemini Flash for memory classification, ranking, consolidation
 * Cobrain v0.5 — WhatsApp classification moved to Stem
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.ts";

const GEMINI_MODEL = "gemini-3-flash-preview";

let genAI: GoogleGenerativeAI | null = null;

/**
 * Initialize Gemini client
 */
export function initHaiku(): boolean {
  const key = config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";

  if (!key) {
    console.warn("[Haiku] GEMINI_API_KEY not configured");
    return false;
  }

  genAI = new GoogleGenerativeAI(key);
  console.log(`[Haiku] Initialized with Gemini model: ${GEMINI_MODEL}`);
  return true;
}

/**
 * Check if Haiku (Gemini) is available
 */
export function isHaikuAvailable(): boolean {
  if (genAI) return true;
  return initHaiku();
}

/**
 * Quick completion helper (now via Gemini)
 */
async function complete(
  prompt: string,
  systemPrompt?: string,
  maxTokens: number = 200
): Promise<string> {
  if (!genAI && !initHaiku()) {
    throw new Error("Gemini not initialized. GEMINI_API_KEY missing.");
  }

  const model = genAI!.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { maxOutputTokens: maxTokens },
    ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
  });

  const HAIKU_TIMEOUT_MS = 15_000; // 15s timeout for Gemini calls
  const resultPromise = model.generateContent(prompt);

  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`[Haiku] Gemini call timed out after ${HAIKU_TIMEOUT_MS}ms`)), HAIKU_TIMEOUT_MS);
  });

  const result = await Promise.race([resultPromise, timeoutPromise]).finally(() => clearTimeout(timeoutId!));
  return result.response.text() || "";
}

/**
 * Extract keywords/tags from text
 */
export async function extractTags(text: string): Promise<string[]> {
  const systemPrompt =
    "You are a keyword extraction assistant. Only write comma-separated keywords, nothing else.";

  const prompt = `Extract the 3-5 most important keywords from the text.

Text: "${text}"

Keywords:`;

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
  const systemPrompt = "You are a summarization assistant. Only write the summary.";

  const prompt = `Summarize this text in a maximum of ${maxWords} words.

Text: "${text}"

Summary:`;

  return (await complete(prompt, systemPrompt, 100)).trim();
}

/**
 * Rank memories by relevance to a query
 */
export async function rankMemories(
  query: string,
  memories: { id: number; content: string; summary?: string; importance?: number; createdAt?: string; accessCount?: number }[],
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
  memories: { id: number; content: string; summary?: string; importance?: number; createdAt?: string; accessCount?: number }[],
  limit: number
): Promise<{ id: number; score: number }[]> {
  const results: { id: number; score: number }[] = [];

  for (const memory of memories) {
    const text = memory.summary || memory.content.slice(0, 200);
    const daysAgo = memory.createdAt
      ? Math.floor((Date.now() - new Date(memory.createdAt).getTime()) / (1000 * 60 * 60 * 24))
      : undefined;
    const score = await scoreRelevance(query, text, memory.importance, daysAgo, memory.accessCount);
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
  memoryContent: string,
  importance?: number,
  daysAgo?: number,
  accessCount?: number
): Promise<number> {
  const systemPrompt =
    "You are a relevance scoring assistant. Only write a number between 0-100.";

  const metaLine = importance !== undefined || daysAgo !== undefined || accessCount !== undefined
    ? `\nImportance: ${importance ?? "?"}/1.0 | Age: ${daysAgo ?? "?"} days | Access: ${accessCount ?? 0}`
    : "";

  const prompt = `Query: "${query}"
Memory: "${memoryContent}"${metaLine}

Score how relevant this memory is to the query on a scale of 0-100.${metaLine ? "\nGive a slight bonus to more important and frequently accessed memories." : ""}`;

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
  memories: { id: number; content: string; summary?: string; importance?: number; createdAt?: string; accessCount?: number }[],
  limit: number
): Promise<{ id: number; score: number }[]> {
  const memoriesText = memories
    .slice(0, 20) // Limit to 20 for batch
    .map((m, i) => {
      const text = m.summary || m.content.slice(0, 100);
      const daysAgo = m.createdAt
        ? Math.floor((Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24))
        : "?";
      return `${i + 1}. ${text} [importance:${m.importance ?? "?"},age:${daysAgo}d,access:${m.accessCount ?? 0}]`;
    })
    .join("\n");

  const systemPrompt =
    "You are a memory ranking assistant. Write in NUMBER:SCORE format on each line.";

  const prompt = `Query: "${query}"

Memories:
${memoriesText}

Provide the numbers and scores (0-100) of the ${limit} most relevant memories.
Give a slight bonus to more important and frequently accessed memories.
Format: NUMBER:SCORE (one per line)`;

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

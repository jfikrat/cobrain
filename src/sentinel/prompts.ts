/**
 * Sentinel Prompts — Builds the system prompt for Haiku Sentinel.
 * Injects knowledge base files + notebook seed content.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.ts";
import type { Notebook } from "./notebook.ts";

const KNOWLEDGE_FILES = ["auto_replies.md", "rules.md", "people.md", "routines.md", "locations.md"];

let knowledgeCache: { content: string; loadedAt: number } | null = null;
const KNOWLEDGE_TTL_MS = 60 * 60 * 1000; // 1 hour

function getKnowledgeCandidates(): string[] {
  const configuredPath = config.BRAIN_LOOP_KNOWLEDGE_PATH || "knowledge";
  const candidates = configuredPath.startsWith("/")
    ? [configuredPath]
    : [
        resolve(config.COBRAIN_BASE_PATH, configuredPath),
        resolve(process.cwd(), configuredPath),
      ];

  return Array.from(new Set(candidates));
}

function resolveKnowledgePath(): string | null {
  for (const candidate of getKnowledgeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadKnowledge(): string {
  const now = Date.now();
  if (knowledgeCache && now - knowledgeCache.loadedAt < KNOWLEDGE_TTL_MS) {
    return knowledgeCache.content;
  }

  const knowledgePath = resolveKnowledgePath();
  const parts: string[] = [];

  try {
    if (!knowledgePath) {
      knowledgeCache = { content: "", loadedAt: now };
      return "";
    }

    for (const file of KNOWLEDGE_FILES) {
      const filePath = join(knowledgePath, file);
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          parts.push(`### ${file.replace(".md", "")}\n${content.trim()}`);
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch (err) {
    console.warn("[Sentinel:Prompts] Knowledge load failed:", err);
  }

  const combined = parts.join("\n\n");
  knowledgeCache = { content: combined, loadedAt: now };
  return combined;
}

export function buildSentinelSystemPrompt(notebook: Notebook): string {
  const knowledge = loadKnowledge();
  const notebookContent = notebook.getSeedContent();

  return `Sen Cobrain Sentinel'isin. Fekrat'ın arka plan nöbetçisi olarak çalışıyorsun.

GÖREV: WhatsApp mesajlarını, hatırlatıcıları ve beklentileri izle. Basit işleri kendin hallet, karmaşık kararları Opus'a bırak.

KARAR ÇERÇEVESİ:
- TIER 1 (basit, kendin cevapla): Selamlama, "neredesin?", "müsait misin?", teşekkür, onay, kısa bilgi sorusu → send_whatsapp_reply kullan
- TIER 2 (karar gerekli, Opus'a ver): Buluşma teklifi, plan değişikliği, önemli soru, duygusal konu → wake_opus kullan
- TIER 3 (sessiz, sadece not al): Medya paylaşımı, emoji, "tamam", "ok", grup sohbeti → update_notebook ile deftere not al, bildirim gönderme

KURALLAR:
1. Kısa, samimi, doğal cevaplar yaz. Makine gibi değil, arkadaş gibi.
2. Türkçe yaz.
3. Emin olmadığında cevaplama, wake_opus kullan.
4. Sessiz saatler (23:00-08:00): Sadece acil konularda bildirim. Tier 1 cevaplar normal devam eder.
5. Aynı kişiye kısa sürede birden fazla cevap verme.
6. Grup mesajlarında sadece Fekrat'a doğrudan hitap edilmişse veya kurallarda belirtilmişse cevap ver.
7. Periyodik kontrollerde yapacak bir şey yoksa hiçbir tool çağırma.
8. Defterini güncel tut — önemli olayları, öğrendiklerini not al.
9. Beklenti (expectation) timeout'larında ilgili kişiye hatırlatma yap veya Opus'a bildir.

KONSOLIDASYON: Context dolmaya yaklaştığında sana bildirilecek. O zaman:
1. update_notebook ile defterindeki tüm bölümleri güncelle
2. store_memory ile kalıcı bilgileri hafızaya kaydet
3. "CONSOLIDATED" yaz

${knowledge ? `\nBİLGİ TABANI:\n${knowledge}\n` : ""}
DEFTERİM (son durum):
${notebookContent}`;
}

/**
 * Stem Prompts — Builds system prompt for Haiku Stem.
 * Uses same mind/ files as Cortex + FileMemory context.
 * Stem = Cortex'in ucuz ikizi: aynı bilgi, daha hızlı karar.
 */

import { readMindFiles } from "../agent/prompts.ts";
import { FileMemory } from "../memory/file-memory.ts";
import type { Notebook } from "./notebook.ts";

export async function buildStemSystemPrompt(userFolder: string, notebook: Notebook): Promise<string> {
  // Same mind files as Cortex (identity, rules, contacts, etc.)
  const mindContent = await readMindFiles(userFolder);

  // FileMemory context (facts + 7 days events — enough for Stem decisions)
  let memorySection = "";
  try {
    const fileMemory = new FileMemory(userFolder);
    const facts = await fileMemory.readFacts();
    const events = await fileMemory.readRecentEvents(7);
    const parts: string[] = [];
    if (facts) parts.push(`### Kalıcı Bilgiler\n${facts}`);
    if (events) parts.push(`### Son Olaylar (7 gün)\n${events}`);
    if (parts.length > 0) memorySection = parts.join("\n\n");
  } catch { /* hafıza okunamazsa devam et */ }

  const notebookContent = notebook.getSeedContent();
  const now = new Date().toLocaleString("tr-TR", {
    weekday: "long", hour: "2-digit", minute: "2-digit",
  });

  return `${mindContent}

---

## Stem Karar Çerçevesi

Sen Cobrain'in Stem katmanısın — Haiku tabanlı hızlı arka plan nöbetçisi.
Cortex (Sonnet) uyurken WA mesajlarını, hatırlatıcıları ve periyodik görevleri işlersin.
Şu an: ${now}

### Karar Çerçevesi

- **TIER 1** (kendin cevapla): Selamlama, "neredesin?", teşekkür, onay, kısa bilgi → \`send_whatsapp_reply\`
- **TIER 2** (Cortex'e devret): Buluşma teklifi, plan, önemli soru, duygusal konu → \`wake_cortex\`
- **TIER 3** (sessiz geç): Medya, emoji, "tamam", grup spam → \`update_notebook\` (bildirim yok)

### Kurallar

1. Kısa, samimi, doğal cevaplar. Arkadaş gibi yaz.
2. Türkçe yaz.
3. Emin olmadığında cevaplama — wake_cortex kullan.
4. Sessiz saatler (23:00-08:00): Sadece acil konularda bildirim. Tier 1 cevaplar devam eder.
5. Aynı kişiye kısa sürede birden fazla cevap verme.
6. Grup mesajlarında sadece Fekrat'a doğrudan hitap edilmişse cevap ver.
7. Periyodik kontrollerde yapacak bir şey yoksa hiçbir tool çağırma — sessiz kal.
8. Defterini güncel tut — önemli olayları not al.

### Konsolidasyon

Context dolmaya yaklaşınca: update_notebook → store_memory → "CONSOLIDATED" yaz.
${memorySection ? `\n---\n\n## Hafıza Özeti\n\n${memorySection}` : ""}

---

## Defterim

${notebookContent}`;
}

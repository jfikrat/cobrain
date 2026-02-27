/**
 * Stem Prompts — Builds triage system prompt.
 * Only reads contacts.md for tier info — no FileMemory, no notebook.
 */

import { join } from "node:path";

export async function buildTriagePrompt(userFolder: string): Promise<string> {
  // Only contacts.md needed for triage decisions
  let contacts = "";
  try {
    contacts = await Bun.file(join(userFolder, "mind", "contacts.md")).text();
  } catch { /* contacts dosyası yoksa devam et */ }

  const now = new Date().toLocaleString("tr-TR", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `Sen Cobrain'in triage katmanısın — gelen olayı değerlendir ve JSON döndür.
Şu an: ${now}

## Karar Çerçevesi

- **reply**: Selamlama, teşekkür, onay, "neredesin?", kısa bilgi → doğrudan cevapla
- **wake_cortex**: Buluşma teklifi, plan, önemli soru, iş konusu, duygusal konu → Cortex'e devret
- **notify**: Bilinmeyen kişi veya önemli ama cevap gerektirmeyen → Telegram bildirimi
- **ignore**: Medya, sticker, "tamam", grup spam, anlamsız mesaj → sessiz geç

## Contact Tier Kuralları

- **T1-T3** (eş, yakın aile, yakın arkadaş): Her zaman en az reply; önemli konularda wake_cortex
- **T4-T5** (tanıdık, iş arkadaşı): Birden fazla mesaj veya önemli konu → wake_cortex; tek selamlama → reply
- **T6** (uzak tanıdık): Birden fazla mesaj → wake_cortex; tek mesaj → reply veya ignore
- **T7 / bilinmeyen / listede yok**: Her zaman en az notify. Hiçbir zaman ignore seçme.
- **Tier bilinmiyorsa**: T7 kuralını uygula

## Kurallar

1. Kısa, samimi, doğal cevaplar. Arkadaş gibi yaz. Gelen mesajın dilinde cevap ver.
2. Emin olmadığında cevaplama — wake_cortex kullan.
3. Sessiz saatler (23:00-08:00): Sadece acil konularda wake_cortex. reply devam eder.
4. Aynı kişiye kısa sürede birden fazla cevap verme.
5. Grup mesajlarında sadece Fekrat'a doğrudan hitap edilmişse cevap ver.
6. Hatırlatıcılar için her zaman notify kullan.
7. Beklenti timeout için wake_cortex kullan.

## JSON Format

Sadece JSON döndür, başka bir şey yazma:
{ "action": "reply|wake_cortex|notify|ignore", "reply": "mesaj (sadece action=reply ise)", "reason": "kısa açıklama", "urgency": "immediate|soon (sadece action=wake_cortex ise)" }

${contacts ? `## Kişiler\n\n${contacts}` : ""}`;
}

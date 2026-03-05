/**
 * Cobrain System Prompts
 * Agent SDK için system prompt yönetimi
 * v0.4 - MD-based System Prompt
 */

import { join } from "node:path";

/**
 * Dynamic context injected into system prompt per conversation
 */
export interface DynamicContext {
  time: {
    now: string;        // "08 Şubat 2026, Pazar, 02:30"
    dayPart: string;    // "gece" | "sabah" | "öğle" | "akşam"
    isWeekend: boolean;
  };
  mood?: {
    current: string;    // "good", "low" etc.
    energy: number;     // 1-5
    trend: string;      // "improving" | "stable" | "declining"
  };
  recentMemories?: string[];  // Son 5 hafıza entry'sinin content'leri
  recentWhatsApp?: Array<{
    senderName: string;
    preview: string;
    tier: number;
    autoReply?: string;
    isGroup: boolean;
    minutesAgo: number;
  }>;
  hubAgents?: {
    agents: Array<{
      id: string;
      name: string;
      type: string;
      lastActiveAgo?: string;
    }>;
    recentActivity?: Array<{
      agentId: string;
      summary: string;
      minutesAgo: number;
    }>;
  };
  sessionState?: {
    lastTopic: string | null;
    topicContext: string;
    pendingActions: string[];
    conversationPhase: string;
    lastUserMessage: string;
  };
  channel?: string; // "telegram" | "api" | "wa" etc.
}

/**
 * Build dynamic context XML (time, mood, recent memories)
 *
 * Token budget targets (enforced in chat.ts before injection):
 * - recentMemories: max 5 entries, each ≤200 chars, deduplicated
 * - recentWhatsApp: max 5 entries, preview ≤150 chars, autoReply ≤100 chars
 * - sessionState.lastUserMessage: ≤500 chars (truncated in chat.ts)
 * Total dynamic context target: ~800-1200 tokens
 */
function buildDynamicContextXml(ctx: DynamicContext): string {
  let xml = `<dynamic-context>
  <time now="${escapeXml(ctx.time.now)}" dayPart="${escapeXml(ctx.time.dayPart)}" isWeekend="${ctx.time.isWeekend}"/>`;

  if (ctx.channel) {
    xml += `\n  <channel>${escapeXml(ctx.channel)}</channel>`;
  }

  if (ctx.mood) {
    xml += `\n  <mood current="${escapeXml(ctx.mood.current)}" energy="${ctx.mood.energy}" trend="${escapeXml(ctx.mood.trend)}"/>`;
  }

  if (ctx.recentMemories && ctx.recentMemories.length > 0) {
    xml += `\n  <recent-memories>`;
    for (const mem of ctx.recentMemories) {
      xml += `\n    <memory>${escapeXml(mem)}</memory>`;
    }
    xml += `\n  </recent-memories>`;
  }

  if (ctx.sessionState && ctx.sessionState.lastTopic) {
    xml += `\n  <session-continuity>`;
    xml += `\n    <last-topic>${escapeXml(ctx.sessionState.lastTopic)}</last-topic>`;
    xml += `\n    <phase>${escapeXml(ctx.sessionState.conversationPhase)}</phase>`;
    if (ctx.sessionState.lastUserMessage) {
      xml += `\n    <last-user-message>${escapeXml(ctx.sessionState.lastUserMessage)}</last-user-message>`;
    }
    if (ctx.sessionState.pendingActions.length > 0) {
      xml += `\n    <pending-actions>`;
      for (const action of ctx.sessionState.pendingActions) {
        xml += `\n      <action>${escapeXml(action)}</action>`;
      }
      xml += `\n    </pending-actions>`;
    }
    xml += `\n  </session-continuity>`;
  }

  if (ctx.recentWhatsApp && ctx.recentWhatsApp.length > 0) {
    xml += `\n  <recent-whatsapp>`;
    for (const wa of ctx.recentWhatsApp) {
      const attrs = [
        `sender="${escapeXml(wa.senderName)}"`,
        `group="${wa.isGroup}"`,
        `tier="${wa.tier}"`,
        `minutes-ago="${wa.minutesAgo}"`,
      ];
      if (wa.autoReply) {
        attrs.push(`auto-reply="${escapeXml(wa.autoReply)}"`);
      }
      xml += `\n    <message ${attrs.join(' ')}>${escapeXml(wa.preview)}</message>`;
    }
    xml += `\n  </recent-whatsapp>`;
  }

  if (ctx.hubAgents && ctx.hubAgents.agents.length > 0) {
    xml += `\n  <hub-agents hint="Agent'larla etkileşim için: agent_delegate (mesaj gönder), agent_get_history (geçmişi oku). Kaynak kodu arama — bu tool'ları kullan.">`;
    for (const agent of ctx.hubAgents.agents) {
      const lastActive = agent.lastActiveAgo ? ` lastActive="${escapeXml(agent.lastActiveAgo)}"` : "";
      xml += `\n    <agent id="${escapeXml(agent.id)}" name="${escapeXml(agent.name)}" type="${escapeXml(agent.type)}"${lastActive}/>`;
    }
    if (ctx.hubAgents.recentActivity && ctx.hubAgents.recentActivity.length > 0) {
      xml += `\n    <recent-activity>`;
      for (const act of ctx.hubAgents.recentActivity) {
        xml += `\n      <interaction agent="${escapeXml(act.agentId)}" minutes-ago="${act.minutesAgo}">${escapeXml(act.summary)}</interaction>`;
      }
      xml += `\n    </recent-activity>`;
    }
    xml += `\n  </hub-agents>`;
  }

  xml += `\n</dynamic-context>`;
  return xml;
}

// ========== Helper Functions ==========

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ========== MD-based System Prompt ==========

const MIND_FILES = ["identity.md", "capabilities.md", "rules.md", "memory.md", "behaviors.md", "user.md", "contacts.md"];

/**
 * Read mind/*.md files from the user's folder and concatenate them.
 * Files that don't exist are silently skipped.
 */
export async function readMindFiles(userFolder: string): Promise<string> {
  const mindDir = join(userFolder, "mind");
  const sections: string[] = [];

  for (const file of MIND_FILES) {
    try {
      const content = await Bun.file(join(mindDir, file)).text();
      if (content.trim()) sections.push(content.trim());
    } catch { /* file doesn't exist — skip */ }
  }

  if (sections.length === 0) {
    return `# Cobrain\nSen Cobrain adlı kişisel AI asistansın. Türkçe konuş. Kendini Claude olarak tanıtma.`;
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build system prompt from mind/*.md content + optional dynamic context.
 */
export function buildMdSystemPrompt(mindContent: string, dynamicContext?: DynamicContext): string {
  const preamble = `# KİMLİK UYARISI

Sen "Cobrain" adlı bir AI asistansın. "Claude Code" veya "Claude" DEĞİLSİN.
Kullanıcı sana kim olduğunu sorduğunda SADECE "Cobrain" olarak tanıt.

---

# GELEN KUTUSU PROTOKOLÜ

\`[GELEN KUTUSU — STEM]\` veya \`[GELEN KUTUSU — MNEME]\` ile başlayan mesajlar
**kullanıcıdan değil**, arka plan sisteminden (Stem / BrainLoop) geliyor.
Kullanıcı o an meşgul değil ya da çevrimdışı — bu mesajlar senin boşlukta işlemen için biriktirilmiş.

**Davranış kuralları:**
- Kullanıcıya "Mesajınızı aldım" gibi onay mesajı GÖNDERME — kullanıcı görmez.
- Mesajın içeriğine göre **otonom aksiyon** al: WhatsApp cevap, hafıza kaydet, beklenti oluştur vb.
- Sonucu **Telegram ile bildir** — kısa, özlü (kullanıcı sonra görecek).
- Tekil WA mesajı veya ufak bir event için aksiyona gerek yoksa sessizce işle, bildirim gönderme.
- **İSTİSNA — her zaman Telegram'a bildir:**
  - "Gece özeti" veya "Morning digest" türü mesajlar → gece olanları kısaca özetle, aksiyon alındıysa belirt
  - Birden fazla konuyu kapsayan özetler → her zaman kullanıcıya raporla
  - Önemli beklenti timeout'ları (yanıt gelmedi, randevu kaçırıldı vb.)

**Örnek akışlar:**
- Stem: "Ali mesaj attı, acil görünüyor" → WhatsApp'tan cevap yaz + Telegram'a "Ali'ye cevap verdim" de
- Stem: "Randevu yarın saat 10" → Hafızaya kaydet + gerekirse Telegram bildirimi
- Stem: "Gece özeti — 2 mesaj sessizce geçti" → Telegram'a "Gece Burak [Resim] attı, Ahmet 'yarın müsait misin?' dedi. Sabah bakman yeterli." de

---

`;
  const dynamic = dynamicContext ? '\n\n' + buildDynamicContextXml(dynamicContext) : '';

  const suggestionBlock = `

## Öneri Butonları

Yanıtlarının sonuna isteğe bağlı olarak 2-3 takip önerisi ekleyebilirsin:

<suggestions>
Bugünkü programım ne?
Son maillerime bak
</suggestions>

Kurallar:
- Her öneri max 30 karakter, kısa ve net
- Her yanıtta değil, sadece doğal devam noktalarında ekle
- Bağlamla alakalı somut sorular veya aksiyonlar olsun
- Gelen Kutusu mesajlarına yanıt verirken ekleme`;

  return `${preamble}${mindContent}${dynamic}${suggestionBlock}`;
}


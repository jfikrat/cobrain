/**
 * Cobrain System Prompts
 * Agent SDK için system prompt yönetimi
 * v0.3 - Dynamic Persona System
 */

import type { UserSettings } from "../types/user.ts";
import type { Persona } from "../types/persona.ts";
import { DEFAULT_PERSONA } from "../types/persona.ts";

/**
 * Ana Cobrain system prompt'u oluştur (legacy, settings-based)
 * @deprecated Use generatePersonaSystemPrompt instead
 */
export function generateSystemPrompt(userId: number, settings: UserSettings): string {
  const name = settings.profileName || "Kullanıcı";
  const role = settings.profileRole || "";
  const interests = settings.profileInterests?.join(", ") || "";
  const notes = settings.profileNotes || "";

  const userContext = buildUserContext(name, role, interests, notes, userId);

  return `# Cobrain — Kişisel AI Asistanı

Senin adın **Cobrain**. Telegram üzerinden konuşan, güvenilir bir kişisel AI asistansın.

ASLA kendini "Claude" olarak tanıtma. Kimliğin her zaman **Cobrain**.

## Persona ve Kişilik

- Rolün: "akıllı ikinci beyin + pratik asistan"
- Tonun: samimi, net, sakin, profesyonel
- Tavrın: çözüm odaklı, gereksiz teoriye girmeyen
- Önceliğin: kullanıcının işini hızlandırmak
- Yaklaşımın: küçük, güvenli adımlar; hızlı geri bildirim

${userContext}

## Çalışma İlkeleri

1. Önce sonucu ver, sonra kısa gerekçe ekle
2. Emin olmadığın yerde kısa netleştirme sorusu sor
3. Bir işi yapmadan önce niyeti 1 cümlede özetle
4. Hata durumunda: nedeni söyle, sonraki adımı öner

## Araçların (MCP Tools)

### Hafıza Araçları
- **remember**: Önemli bilgileri uzun vadeli hafızaya kaydet
- **recall**: Hafızada ara, ilgili bilgileri getir

### Google Drive (rclone)
- **gdrive_list**: Dosyaları listele
- **gdrive_link**: Paylaşılabilir link oluştur
- **gdrive_download**: Dosya indir
- **gdrive_upload**: Dosya yükle

### Squad MCP - Multi-Agent Araçlar
- **mcp__squad__codex**: GPT-5.2 Codex (message, workDir)
- **mcp__squad__gemini**: Gemini 3 (message, workDir, model?)
- **mcp__squad__claude**: Claude Opus 4.5 (message, workDir)
- **mcp__squad__parallel_search**: Paralel arama (queries, workDir)

### Telegram Araçları
- **telegram_send_photo**: Kullanıcıya resim gönder
- **telegram_send_document**: Kullanıcıya dosya gönder

### Sistem Araçları
- Bash, Read, Write, Edit, Glob, Grep - standart dosya/kod işlemleri

## Kurallar

1. Kullanıcının dosyalarına dikkat et, izinsiz silme yapma
2. Hassas bilgileri (şifre, token) loglama
3. Silme işlemlerinde önce listele, onay iste
4. Türkçe konuş, teknik terimler İngilizce olabilir
5. Telegram için kısa ve öz yanıtlar ver
6. Tablolar yerine liste formatı kullan (Telegram tabloları desteklemiyor)

## Format

- Kısa paragraflar
- Bullet listeler
- Kod blokları için \`\`\` kullan
- Emoji kullanma (kullanıcı istemediği sürece)
`;
}

/**
 * Kullanıcı bağlamı bloğu oluştur (legacy)
 */
function buildUserContext(
  name: string,
  role: string,
  interests: string,
  notes: string,
  userId: number
): string {
  if (!role && !interests && name === "Kullanıcı") {
    return `## Kullanıcı Bağlamı

- Kullanıcı ID: ${userId}
- Dil tercihi: Türkçe
- Hitap: "sen"`;
  }

  let context = `## Kullanıcı Bağlamı (${name})

- Kullanıcı adı: ${name}`;

  if (role) {
    context += `\n- Meslek/Rol: ${role}`;
  }

  if (interests) {
    context += `\n- İlgi alanları: ${interests}`;
  }

  context += `\n- Dil tercihi: Türkçe
- Hitap: "sen"`;

  if (notes) {
    context += `\n- Özel notlar: ${notes}`;
  }

  return context;
}

// ========== NEW: Persona-based System Prompt ==========

/**
 * Generate XML-structured system prompt from persona
 */
export function generatePersonaSystemPrompt(persona: Persona): string {
  const xml = buildPersonaXml(persona);
  const tools = buildToolsSection();
  const rules = buildRulesSection(persona);
  const format = buildFormatSection(persona);

  return `${xml}

${tools}

${rules}

${format}`;
}

/**
 * Build XML persona block
 */
function buildPersonaXml(persona: Persona): string {
  const { identity, voice, behavior, boundaries, userContext } = persona;

  // Voice descriptions
  const formalityDesc = getFormalityDescription(voice.formality);
  const verbosityDesc = getVerbosityDescription(voice.verbosity);
  const proactivityDesc = getProactivityDescription(behavior.proactivity);

  // Topics to avoid
  const topicsXml = boundaries.topicsToAvoid.length > 0
    ? `\n  <topics-to-avoid>
${boundaries.topicsToAvoid.map(t => `    <topic>${escapeXml(t)}</topic>`).join('\n')}
  </topics-to-avoid>`
    : '';

  // Permission requirements
  const permissionsXml = boundaries.alwaysAskPermission.length > 0
    ? `\n  <always-ask-permission>
${boundaries.alwaysAskPermission.map(a => `    <action>${escapeXml(a)}</action>`).join('\n')}
  </always-ask-permission>`
    : '';

  // User context
  const userContextXml = buildUserContextXml(userContext);

  return `<cobrain-system-prompt version="1.0">

<identity>
  <name>${escapeXml(identity.name)}</name>
  <role>${escapeXml(identity.role)}</role>${identity.tagline ? `\n  <tagline>${escapeXml(identity.tagline)}</tagline>` : ''}
  <core-values>${identity.coreValues.map(escapeXml).join(', ')}</core-values>
  <critical>Kendini ASLA "Claude" olarak tanıtma. Kimliğin her zaman "${escapeXml(identity.name)}".</critical>
</identity>

<voice>
  <tone>${escapeXml(voice.tone)}</tone>
  <formality level="${voice.formality}">${formalityDesc}</formality>
  <verbosity level="${voice.verbosity}">${verbosityDesc}</verbosity>
  <emoji-usage>${voice.emojiUsage}</emoji-usage>
  <language>${voice.language}</language>
  <address-form>${voice.addressForm}</address-form>
</voice>

<behavior>
  <proactivity level="${behavior.proactivity}">${proactivityDesc}</proactivity>
  <clarification-threshold level="${behavior.clarificationThreshold}">${getClarificationDesc(behavior.clarificationThreshold)}</clarification-threshold>
  <error-handling>${behavior.errorHandling}</error-handling>
  <response-style>${behavior.responseStyle}</response-style>
</behavior>

<boundaries>${topicsXml}${permissionsXml}
  <max-response-length>${boundaries.maxResponseLength}</max-response-length>
</boundaries>

${userContextXml}

</cobrain-system-prompt>`;
}

/**
 * Build user context XML section
 */
function buildUserContextXml(ctx: Persona['userContext']): string {
  let xml = `<user-context name="${escapeXml(ctx.name)}">`;

  if (ctx.role) {
    xml += `\n  <role>${escapeXml(ctx.role)}</role>`;
  }

  if (ctx.interests.length > 0) {
    xml += `\n  <interests>
${ctx.interests.map(i => `    <interest>${escapeXml(i)}</interest>`).join('\n')}
  </interests>`;
  }

  if (Object.keys(ctx.preferences).length > 0) {
    xml += `\n  <preferences>
${Object.entries(ctx.preferences).map(([k, v]) => `    <pref key="${escapeXml(k)}">${escapeXml(v)}</pref>`).join('\n')}
  </preferences>`;
  }

  if (Object.keys(ctx.importantDates).length > 0) {
    xml += `\n  <important-dates>
${Object.entries(ctx.importantDates).map(([k, v]) => `    <date key="${escapeXml(k)}">${escapeXml(v)}</date>`).join('\n')}
  </important-dates>`;
  }

  if (ctx.communicationNotes.length > 0) {
    xml += `\n  <communication-notes>
${ctx.communicationNotes.map(n => `    <note>${escapeXml(n)}</note>`).join('\n')}
  </communication-notes>`;
  }

  xml += '\n</user-context>';
  return xml;
}

/**
 * Build tools section
 */
function buildToolsSection(): string {
  return `## Araçların (MCP Tools)

### Hafıza Araçları
- **remember**: Önemli bilgileri uzun vadeli hafızaya kaydet
- **recall**: Hafızada ara, ilgili bilgileri getir

### Persona Araçları
- **get_persona**: Mevcut persona ayarlarını görüntüle
- **update_persona**: Auto-approve alanları güncelle
- **suggest_persona_change**: Onay gerektiren değişiklik öner
- **learn_user_context**: Kullanıcı hakkında bilgi öğren

### Hedef & Hatırlatıcı
- **create_goal**: Hedef oluştur
- **list_goals**: Hedefleri listele
- **create_reminder**: Hatırlatıcı kur
- **list_reminders**: Hatırlatıcıları listele

### Google Drive (rclone)
- **gdrive_list**: Dosyaları listele
- **gdrive_link**: Paylaşılabilir link oluştur
- **gdrive_download**: Dosya indir
- **gdrive_upload**: Dosya yükle

### Squad MCP - Multi-Agent Araçlar
Squad MCP üzerinden 3 farklı AI modeline erişebilirsin:

- **mcp__squad__codex**: GPT-5.2 Codex - Derin teknik analiz, mimari inceleme, debugging
  - Parametreler: message (string), workDir (string - her zaman mevcut çalışma dizini)

- **mcp__squad__gemini**: Gemini 3 Flash/Pro - Hızlı analiz, genel sorgular
  - Parametreler: message (string), workDir (string), model? ("flash" | "pro")

- **mcp__squad__claude**: Claude Opus 4.5 - Kod analizi, düzenleme, karmaşık görevler
  - Parametreler: message (string), workDir (string)
  - Read, Edit, Write, Bash, Grep, Glob araçlarına erişimi var

- **mcp__squad__parallel_search**: Paralel arama - 2 Gemini + 2 Codex aynı anda
  - Parametreler: queries (string[], max 4), workDir (string)

**ÖNEMLİ**: Squad araçlarını kullanırken HER ZAMAN workDir parametresine mevcut çalışma dizinini geç!

### Telegram Araçları
- **telegram_send_photo**: Kullanıcıya resim gönder
- **telegram_send_document**: Kullanıcıya dosya gönder
- **telegram_send_message_with_buttons**: Butonlu mesaj gönder

### Helm - Browser Kontrolü
- **helm_***: Chrome tarayıcı kontrolü (tab açma, tıklama, form doldurma vs.)

### Sistem Araçları
- Bash, Read, Write, Edit, Glob, Grep - standart dosya/kod işlemleri`;
}

/**
 * Build rules section based on persona
 */
function buildRulesSection(persona: Persona): string {
  const { behavior, boundaries, voice } = persona;

  let rules = `## Çalışma İlkeleri

`;

  // Response style rules
  switch (behavior.responseStyle) {
    case 'result-first':
      rules += '1. Önce sonucu ver, sonra kısa gerekçe ekle\n';
      break;
    case 'explanation-first':
      rules += '1. Önce bağlamı açıkla, sonra sonucu ver\n';
      break;
    case 'balanced':
      rules += '1. Sonuç ve gerekçeyi dengeli şekilde sun\n';
      break;
  }

  // Clarification behavior
  if (behavior.clarificationThreshold < 0.4) {
    rules += '2. Çoğu zaman varsayımlarla ilerle, sadece kritik belirsizliklerde sor\n';
  } else if (behavior.clarificationThreshold > 0.7) {
    rules += '2. Emin olmadığın her yerde netleştirme sorusu sor\n';
  } else {
    rules += '2. Emin olmadığın yerde kısa netleştirme sorusu sor\n';
  }

  rules += '3. Bir işi yapmadan önce niyeti 1 cümlede özetle\n';

  // Error handling style
  switch (behavior.errorHandling) {
    case 'apologetic':
      rules += '4. Hata durumunda: özür dile, nedeni açıkla, düzelt\n';
      break;
    case 'matter-of-fact':
      rules += '4. Hata durumunda: nedeni söyle, sonraki adımı öner\n';
      break;
    case 'humorous':
      rules += '4. Hata durumunda: hafif espriyle geç, çözümü öner\n';
      break;
  }

  // Core rules
  rules += `
## Kurallar

1. Kullanıcının dosyalarına dikkat et, izinsiz silme yapma
2. Hassas bilgileri (şifre, token) loglama`;

  // Permission requirements
  for (const action of boundaries.alwaysAskPermission) {
    rules += `\n3. ${action.charAt(0).toUpperCase() + action.slice(1)} işlemlerinde önce listele, onay iste`;
  }

  rules += `\n4. ${voice.language === 'tr' ? 'Türkçe' : voice.language} konuş, teknik terimler İngilizce olabilir`;
  rules += '\n5. Telegram için kısa ve öz yanıtlar ver';
  rules += '\n6. Tablolar yerine liste formatı kullan (Telegram tabloları desteklemiyor)';

  return rules;
}

/**
 * Build format section based on persona
 */
function buildFormatSection(persona: Persona): string {
  const { voice, boundaries } = persona;

  let format = `## Format

- Kısa paragraflar
- Bullet listeler
- Kod blokları için \`\`\` kullan`;

  // Emoji usage
  switch (voice.emojiUsage) {
    case 'none':
      format += '\n- Emoji kullanma';
      break;
    case 'minimal':
      format += '\n- Emoji çok seyrek kullan (sadece vurgu için)';
      break;
    case 'moderate':
      format += '\n- Emoji dengeli kullan';
      break;
    case 'frequent':
      format += '\n- Emoji bolca kullan';
      break;
  }

  // Max length hint
  if (boundaries.maxResponseLength < 1500) {
    format += '\n- Yanıtları çok kısa tut (< 1500 karakter)';
  } else if (boundaries.maxResponseLength > 3000) {
    format += '\n- Gerektiğinde detaylı yanıt ver';
  }

  return format;
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

function getFormalityDescription(level: number): string {
  if (level < 0.3) return 'günlük, rahat';
  if (level < 0.5) return 'samimi ama profesyonel';
  if (level < 0.7) return 'profesyonel';
  return 'resmi';
}

function getVerbosityDescription(level: number): string {
  if (level < 0.3) return 'çok kısa, öz';
  if (level < 0.5) return 'orta uzunlukta';
  if (level < 0.7) return 'detaylı';
  return 'kapsamlı açıklamalar';
}

function getProactivityDescription(level: number): string {
  if (level < 0.3) return 'Sadece sorulana cevap ver';
  if (level < 0.5) return 'Gerektiğinde öneri ver';
  if (level < 0.7) return 'Aktif olarak öneri ve hatırlatma yap';
  return 'Proaktif: sürekli iyileştirme öner, takip et';
}

function getClarificationDesc(level: number): string {
  if (level < 0.4) return 'Varsayımlarla ilerle';
  if (level < 0.7) return 'Belirsizlikte sor';
  return 'Her detayı netleştir';
}

/**
 * Memory extraction için prompt
 */
export const MEMORY_EXTRACTION_PROMPT = `
Aşağıdaki konuşmadan önemli bilgileri çıkar:
- Kişisel bilgiler (isim, meslek, tercihler)
- Öğrenilen gerçekler
- Verilen talimatlar
- Hatırlanması istenen şeyler

Sadece gerçekten önemli ve kalıcı bilgileri çıkar.
Geçici veya bağlamsal bilgileri atla.
`;

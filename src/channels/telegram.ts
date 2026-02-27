import { Bot, InlineKeyboard } from "grammy";
import { run } from "@grammyjs/runner";
import { config } from "../config.ts";
import { heartbeat } from "../services/heartbeat.ts";
import { think, clearSession, getStats, userManager, isVectorMemoryAvailable, type MultimodalMessage } from "../brain/index.ts";
import { initPermissions, clearAllPending } from "../agent/permissions.ts";
import { whatsappDB, type PendingChat } from "../services/whatsapp-db.ts";
import { analyzeMessages, generateSummary, type MessageAnalysis } from "../services/analyzer.ts";
import { getPersonaService } from "../services/persona.ts";
import { applyApprovedPersonaChange, applyApprovedRollback } from "../agent/tools/persona.ts";
import { recordInteraction, extractMoodFromMessage, recordUserActivity } from "../services/interaction-tracker.ts";
import {
  formatSummaryMessage,
  formatDetailMessage,
  formatPersonalList,
  formatGroupList,
  formatReplyPrompt,
  getDetailKeyboard,
  getCategoryKeyboard,
  getPersonalListKeyboard,
  getGroupListKeyboard,
  getReplyKeyboard,
} from "../services/notifier.ts";
import type { PendingMessage } from "../services/whatsapp.ts";
import { generateSessionToken } from "../web/auth.ts";
import { transcribeAudio, downloadTelegramFile, downloadTelegramFileAsBuffer } from "../services/transcribe.ts";
import { initTelegramMcp } from "../agent/tools/telegram.ts";
import { UserMemory } from "../memory/sqlite.ts";

/** Parse <suggestions> block from response, return clean text + suggestions */
function parseSuggestions(content: string): { text: string; suggestions: string[] } {
  const match = content.match(/<suggestions>\n?([\s\S]*?)\n?<\/suggestions>\s*$/);
  if (!match) return { text: content, suggestions: [] };

  const text = content.replace(/<suggestions>[\s\S]*?<\/suggestions>\s*$/, '').trimEnd();
  const suggestions = match[1]!
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length <= 40)
    .slice(0, 3);

  return { text, suggestions };
}

/** Build inline keyboard from suggestion strings */
function buildSuggestionKeyboard(suggestions: string[]): InlineKeyboard | undefined {
  if (suggestions.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (const s of suggestions) {
    kb.text(s, s).row();
  }
  return kb;
}

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Live location cache — think() çağırmadan, sadece in-memory tut
interface LiveLocationEntry {
  latitude: number;
  longitude: number;
  updatedAt: Date;
}
const liveLocationCache = new Map<number, LiveLocationEntry>();

export function getLiveLocation(userId: number): LiveLocationEntry | null {
  return liveLocationCache.get(userId) ?? null;
}

// Initialize Telegram MCP with bot instance
initTelegramMcp(bot);

// Heartbeat interval reference
let telegramHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Geçici state
let cachedAnalysis: MessageAnalysis[] = [];

// Cevaplama modu state'i
interface ReplyState {
  chatJid: string;
  chatName: string;
  messageId: number; // Telegram mesaj ID (editleyebilmek için)
}
const replyStates = new Map<number, ReplyState>(); // userId -> ReplyState

function isAuthorized(userId: number): boolean {
  return userId === config.MY_TELEGRAM_ID;
}

// PendingChat -> PendingMessage dönüşümü
function toPendingMessage(chat: PendingChat): PendingMessage {
  return {
    id: chat.chatJid,
    chatId: chat.chatJid,
    chatName: chat.chatName,
    senderName: chat.senderName,
    message: chat.lastMessage,
    timestamp: chat.lastMessageTime,
    isGroup: chat.isGroup,
    waitingMinutes: chat.waitingMinutes,
  };
}

// ============ KOMUTLAR ============

bot.command("start", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) {
    await ctx.reply("Bu bot özel kullanım içindir.");
    return;
  }

  await ctx.reply(
    `🧠 <b>Cobrain</b> - Kişisel AI Asistan

<b>Komutlar:</b>
/scan - WhatsApp mesajlarını tara
/status - Bot ve WhatsApp durumu
/help - Yardım

<b>AI Sohbet:</b>
Direkt mesaj yaz, cevaplarım.`,
    { parse_mode: "HTML" }
  );
});

bot.command("help", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  await ctx.reply(
    `🧠 <b>Cobrain v0.3 Yardım</b>

<b>AI Sohbet:</b>
Direkt mesaj yaz, Cobrain cevaplar.
Hafıza, hedef, hatırlatıcı işlemleri için doğal dil kullan:
• "Bunu hatırla: ..."
• "Yeni hedef: ..."
• "10 dakika sonra hatırlat: ..."

<b>WhatsApp:</b>
/scan - Cevap bekleyenleri göster
/reply [kişi] [mesaj] - Mesaj gönder

<b>Ayarlar:</b>
/persona - Persona ayarlarını görüntüle
/mode - Permission modunu değiştir

<b>Diğer:</b>
/status - Bot durumu
/clear - Oturumu sıfırla`,
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  const userId = ctx.from?.id ?? 0;
  const userStats = await getStats(userId);
  const waStats = whatsappDB.getStats();
  const waStatus = whatsappDB.getWorkerStatus();
  const ollamaAvailable = await isVectorMemoryAvailable();

  await ctx.reply(
    `🧠 <b>Cobrain v0.2 Durum</b>

<b>Bot:</b> Aktif ✅
<b>AI:</b> Claude CLI (session-based)
<b>Base:</b> <code>${config.COBRAIN_BASE_PATH}</code>

<b>Smart Memory:</b> ${ollamaAvailable ? "Aktif ✅ (Cerebras)" : "Devre dışı ❌"}
${!ollamaAvailable ? "<i>CEREBRAS_API_KEY ayarlanmamış</i>\n" : ""}
<b>WhatsApp Worker:</b> ${waStatus.connected ? "Bağlı ✅" : "Bağlı değil ❌"}
${waStatus.user ? `<b>Hesap:</b> ${waStatus.user}` : ""}

<b>WhatsApp DB:</b>
• Kişiler: ${waStats.contacts}
• Sohbetler: ${waStats.chats}
• Mesajlar: ${waStats.messages}

<b>Senin İstatistiklerin:</b>
• Mesajlar: ${userStats.messageCount}
• Oturumlar: ${userStats.sessionCount}
• Hatıralar: ${userStats.memoryCount}
• Toplam maliyet: $${userStats.totalCost.toFixed(4)}

<b>Runtime:</b> Bun ${Bun.version}`,
    { parse_mode: "HTML" }
  );
});

bot.command("scan", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  await ctx.reply("🔄 WhatsApp mesajları taranıyor...");

  try {
    // Son 24 saatteki cevap bekleyen mesajları al
    const pendingChats = whatsappDB.getPendingChats(24);

    if (pendingChats.length === 0) {
      await ctx.reply(
        `📬 <b>Mesaj Özeti</b>

✅ Son 24 saatte cevap bekleyen mesaj yok!`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Analiz için dönüştür
    const pendingMessages = pendingChats.map(toPendingMessage);

    // Cerebras ile analiz et
    cachedAnalysis = await analyzeMessages(pendingMessages);
    const summary = await generateSummary(cachedAnalysis);

    await ctx.reply(formatSummaryMessage(summary), {
      parse_mode: "HTML",
      reply_markup: getCategoryKeyboard(summary),
    });
  } catch (error) {
    console.error("Scan hatası:", error);
    await ctx.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
  }
});

bot.command("reply", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  const args = ctx.message?.text?.split(" ").slice(1) || [];
  if (args.length < 2) {
    await ctx.reply(
      `Kullanım: /reply [kişi/numara] [mesaj]

Örnek:
/reply 5551234567 Merhaba!
/reply @ahmet Tamam, görüşürüz.`
    );
    return;
  }

  const target = args[0] ?? "";
  const message = args.slice(1).join(" ");

  // Kişiyi bul
  let jid: string;
  if (target.startsWith("+") || /^\d+$/.test(target)) {
    // Numara
    const num = target.replace(/\D/g, "");
    jid = `${num}@s.whatsapp.net`;
  } else {
    // İsim ara
    const contacts = whatsappDB.searchContacts(target.replace("@", ""), 1);
    if (contacts.length === 0 || !contacts[0]) {
      await ctx.reply(`❌ "${target}" bulunamadı.`);
      return;
    }
    jid = contacts[0].jid;
  }

  // Mesajı gönder (outbox'a ekle)
  const id = whatsappDB.sendMessage(jid, message);

  await ctx.reply(
    `✅ Mesaj kuyruğa eklendi (#${id})

<b>Kime:</b> ${jid.split("@")[0]}
<b>Mesaj:</b> ${message}

<i>Worker birkaç saniye içinde gönderecek.</i>`,
    { parse_mode: "HTML" }
  );
});

bot.command("clear", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  const userId = ctx.from?.id ?? 0;
  await clearSession(userId); // Session ve history birlikte temizlenir
  cachedAnalysis = [];

  // Reset session state
  if (config.FF_SESSION_STATE) {
    const { saveSessionState, DEFAULT_SESSION_STATE } = await import("../services/session-state.ts");
    saveSessionState(userId, { ...DEFAULT_SESSION_STATE });
  }

  await ctx.reply(`🗑️ Temizlendi! Session ve sohbet geçmişi sıfırlandı.`);
});

bot.command("phase", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  const userId = ctx.from?.id ?? 0;

  if (!config.FF_SESSION_STATE) {
    await ctx.reply("Session state devre dışı (FF_SESSION_STATE=false)");
    return;
  }

  const { getSessionState, updateSessionState } = await import("../services/session-state.ts");
  const args = ctx.message?.text?.split(" ").slice(1) || [];

  if (args.length === 0) {
    // Show current state
    const state = getSessionState(userId);
    const phaseEmoji: Record<string, string> = {
      exploring: "🔍",
      decided: "✅",
      implementing: "🔨",
      deployed: "🚀",
      archived: "📦",
    };

    let text = `📊 <b>Session State</b>\n\n`;
    text += `<b>Phase:</b> ${phaseEmoji[state.conversationPhase] || ""} ${state.conversationPhase}\n`;
    text += `<b>Topic:</b> ${state.lastTopic || "(yok)"}\n`;
    text += `<b>Confidence:</b> ${(state.confidence * 100).toFixed(0)}%\n`;
    text += `<b>Last message:</b> ${state.lastUserMessage ? state.lastUserMessage.slice(0, 80) + "..." : "(yok)"}\n`;

    if (state.pendingActions.length > 0) {
      text += `\n<b>Pending actions:</b>\n`;
      for (const action of state.pendingActions) {
        text += `• ${action}\n`;
      }
    }

    text += `\n<i>Override: /phase exploring|decided|implementing|deployed|archived</i>`;

    await ctx.reply(text, { parse_mode: "HTML" });
  } else {
    // Manual phase override
    const validPhases = ["exploring", "decided", "implementing", "deployed", "archived"];
    const newPhase = args[0]!.toLowerCase();

    if (!validPhases.includes(newPhase)) {
      await ctx.reply(`Geçersiz phase. Geçerli değerler: ${validPhases.join(", ")}`);
      return;
    }

    updateSessionState(userId, {
      conversationPhase: newPhase as any,
      confidence: 1.0,
    });

    await ctx.reply(`Phase güncellendi: ${newPhase} (confidence: 100%)`);
  }
});

bot.command("restart", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  await ctx.reply("🔄 Bot yeniden başlatılıyor...");

  // Kısa bir gecikme ile mesajın gitmesini bekle
  setTimeout(() => {
    process.exit(0); // systemd otomatik restart yapacak
  }, 500);
});

// ===== Web UI Command =====

bot.command("web", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) return;

  if (!config.ENABLE_WEB_UI) {
    await ctx.reply("❌ Web arayüzü devre dışı.");
    return;
  }

  try {
    const token = generateSessionToken(userId);
    const url = `${config.WEB_URL}?token=${token}`;

    await ctx.reply(
      `🌐 <b>Web Arayüzü</b>\n\n` +
        `Link 24 saat geçerli.\n` +
        `<code>${url}</code>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🌐 Web'de Aç", url }]],
        },
      }
    );

    console.log(`[Web] Token generated for user ${userId}`);
  } catch (error) {
    await ctx.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
  }
});

// ===== Permission Mode Command =====

const PERMISSION_MODE_LABELS: Record<string, string> = {
  strict: "🔒 Strict - Her tool için onay iste",
  smart: "🧠 Smart - Sadece tehlikeli işlemlerde sor",
  yolo: "🚀 YOLO - Hiçbir şey sorma",
};

bot.command("mode", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) return;

  try {
    const settings = await userManager.getUserSettings(userId);
    const currentMode = settings.permissionMode || config.PERMISSION_MODE;
    const modeLabel = PERMISSION_MODE_LABELS[currentMode] || currentMode;

    await ctx.reply(
      `⚙️ *Permission Mode*\n\n` +
      `Mevcut: *${modeLabel}*\n\n` +
      `Mod seç:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: currentMode === "strict" ? "✓ Strict" : "Strict", callback_data: "mode:strict" },
              { text: currentMode === "smart" ? "✓ Smart" : "Smart", callback_data: "mode:smart" },
              { text: currentMode === "yolo" ? "✓ YOLO" : "YOLO", callback_data: "mode:yolo" },
            ],
          ],
        },
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
  }
});

// Handle mode change callbacks
bot.callbackQuery(/^mode:(strict|smart|yolo)$/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) return;

  const mode = ctx.match![1] as "strict" | "smart" | "yolo";

  try {
    await userManager.updateUserSettings(userId, { permissionMode: mode });
    const modeLabel = PERMISSION_MODE_LABELS[mode];

    await ctx.editMessageText(
      `⚙️ *Permission Mode*\n\n` +
      `✅ Mod değiştirildi: *${modeLabel}*`,
      { parse_mode: "Markdown" }
    );
    await ctx.answerCallbackQuery("Mod güncellendi!");

    console.log(`[Bot] User ${userId} changed permission mode to: ${mode}`);
  } catch (error) {
    await ctx.answerCallbackQuery("Hata oluştu!");
  }
});

// ===== Persona Commands & Callbacks =====

bot.command("persona", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) return;

  try {
    const service = await getPersonaService(userId);
    const persona = await service.getActivePersona();

    const toneLabels: Record<string, string> = {
      samimi: "Samimi",
      resmi: "Resmi",
      teknik: "Teknik",
      espirili: "Espirili",
      destekleyici: "Destekleyici",
    };

    const text = `👤 <b>Persona Ayarları</b> (v${persona.version})

<b>Kimlik:</b>
• İsim: ${persona.identity.name}
• Rol: ${persona.identity.role}
• Değerler: ${persona.identity.coreValues.join(", ")}

<b>Ses Tonu:</b>
• Ton: ${toneLabels[persona.voice.tone] || persona.voice.tone}
• Formalite: ${Math.round(persona.voice.formality * 100)}%
• Detay: ${Math.round(persona.voice.verbosity * 100)}%
• Emoji: ${persona.voice.emojiUsage}
• Hitap: ${persona.voice.addressForm}

<b>Davranış:</b>
• Proaktiflik: ${Math.round(persona.behavior.proactivity * 100)}%
• Soru sorma eşiği: ${Math.round(persona.behavior.clarificationThreshold * 100)}%
• Cevap stili: ${persona.behavior.responseStyle}

<b>Kullanıcı Bağlamı:</b>
• İsim: ${persona.userContext.name}${persona.userContext.role ? `\n• Rol: ${persona.userContext.role}` : ""}
• İlgiler: ${persona.userContext.interests.length > 0 ? persona.userContext.interests.join(", ") : "(yok)"}

<i>Ton ve hitap değişiklikleri için agent'a iste.</i>`;

    await ctx.reply(text, { parse_mode: "HTML" });
  } catch (error) {
    await ctx.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
  }
});

// Persona change approval callback
// Format: persona_approve:<field>:<encodedValue>
bot.callbackQuery(/^persona_approve:(.+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) return;

  try {
    const data = ctx.callbackQuery.data.replace("persona_approve:", "");
    const parsed = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));

    const { field, value, reason } = parsed;

    const success = await applyApprovedPersonaChange(userId, field, value, reason);

    if (success) {
      await ctx.editMessageText(
        `✅ <b>Persona güncellendi!</b>\n\n` +
        `Alan: <code>${field}</code>\n` +
        `Yeni değer: <code>${JSON.stringify(value)}</code>`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery("Değişiklik uygulandı!");
      console.log(`[Persona] User ${userId} approved change: ${field} = ${JSON.stringify(value)}`);
    } else {
      await ctx.answerCallbackQuery("Değişiklik uygulanamadı!");
    }
  } catch (error) {
    console.error("Persona approve error:", error);
    await ctx.answerCallbackQuery("Hata oluştu!");
  }
});

// Persona change reject callback
bot.callbackQuery(/^persona_reject$/, async (ctx) => {
  await ctx.editMessageText("❌ Persona değişikliği reddedildi.", { parse_mode: "HTML" });
  await ctx.answerCallbackQuery("Reddedildi");
});

// Persona rollback approval callback
bot.callbackQuery(/^persona_rollback:(\d+)$/, async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) return;

  try {
    const targetVersion = parseInt(ctx.match![1]!, 10);

    const success = await applyApprovedRollback(userId, targetVersion, "Kullanıcı onayladı");

    if (success) {
      await ctx.editMessageText(
        `✅ <b>Persona geri alındı!</b>\n\n` +
        `Versiyon ${targetVersion}'e dönüldü.`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery("Rollback tamamlandı!");
      console.log(`[Persona] User ${userId} rolled back to v${targetVersion}`);
    } else {
      await ctx.answerCallbackQuery("Rollback başarısız!");
    }
  } catch (error) {
    console.error("Persona rollback error:", error);
    await ctx.answerCallbackQuery("Hata oluştu!");
  }
});

// ============ CALLBACK QUERIES (Butonlar) ============

bot.callbackQuery("action:detail", async (ctx) => {
  await ctx.answerCallbackQuery();

  if (cachedAnalysis.length === 0) {
    await ctx.editMessageText("✅ Bekleyen mesaj yok!", { parse_mode: "HTML" });
    return;
  }

  await ctx.editMessageText(formatDetailMessage(cachedAnalysis), {
    parse_mode: "HTML",
    reply_markup: getDetailKeyboard(),
  });
});

bot.callbackQuery("action:suggestions", async (ctx) => {
  await ctx.answerCallbackQuery();

  if (cachedAnalysis.length === 0) {
    await ctx.editMessageText("✅ Bekleyen mesaj yok!");
    return;
  }

  let text = `💬 <b>Cevap Önerileri</b>\n\n`;

  for (const m of cachedAnalysis) {
    if (m.suggestedReply) {
      text += `<b>${m.chatName}:</b>\n`;
      text += `└ <i>"${m.suggestedReply}"</i>\n\n`;
    }
  }

  if (text === `💬 <b>Cevap Önerileri</b>\n\n`) {
    text += "Öneri üretilemedi.";
  }

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: getDetailKeyboard(),
  });
});

bot.callbackQuery("action:summary", async (ctx) => {
  await ctx.answerCallbackQuery();

  const summary = await generateSummary(cachedAnalysis);

  await ctx.editMessageText(formatSummaryMessage(summary), {
    parse_mode: "HTML",
    reply_markup: getCategoryKeyboard(summary),
  });
});

bot.callbackQuery("action:refresh", async (ctx) => {
  await ctx.answerCallbackQuery("🔄 Yenileniyor...");

  try {
    const pendingChats = whatsappDB.getPendingChats(24);
    const pendingMessages = pendingChats.map(toPendingMessage);
    cachedAnalysis = await analyzeMessages(pendingMessages);
    const summary = await generateSummary(cachedAnalysis);

    await ctx.editMessageText(formatSummaryMessage(summary), {
      parse_mode: "HTML",
      reply_markup: getCategoryKeyboard(summary),
    });
  } catch (error) {
    await ctx.editMessageText(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen"}`);
  }
});

bot.callbackQuery("action:dismiss", async (ctx) => {
  await ctx.answerCallbackQuery("✅ Tamam");
  await ctx.editMessageText("✅ Mesajlar görüldü olarak işaretlendi.", {
    parse_mode: "HTML",
  });
  cachedAnalysis = [];
});

// Generic "tamam/ack" callback — buton kaybolsun, toast göster
bot.callbackQuery(/^(restart_ack|ack|tamam)$/, async (ctx) => {
  await ctx.answerCallbackQuery("Tamam");
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
});

// ============ KATEGORİ HANDLER'LAR ============

bot.callbackQuery("category:personal", async (ctx) => {
  await ctx.answerCallbackQuery();

  if (cachedAnalysis.length === 0) {
    await ctx.editMessageText("✅ Bekleyen mesaj yok!", { parse_mode: "HTML" });
    return;
  }

  await ctx.editMessageText(formatPersonalList(cachedAnalysis), {
    parse_mode: "HTML",
    reply_markup: getPersonalListKeyboard(cachedAnalysis),
  });
});

bot.callbackQuery("category:groups", async (ctx) => {
  await ctx.answerCallbackQuery();

  if (cachedAnalysis.length === 0) {
    await ctx.editMessageText("✅ Bekleyen mesaj yok!", { parse_mode: "HTML" });
    return;
  }

  await ctx.editMessageText(formatGroupList(cachedAnalysis), {
    parse_mode: "HTML",
    reply_markup: getGroupListKeyboard(cachedAnalysis),
  });
});

// ============ CEVAPLAMA HANDLER'LAR ============

// reply_start:chatJid:index formatında callback
bot.callbackQuery(/^reply_start:(.+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const match = ctx.callbackQuery.data.match(/^reply_start:(.+):(\d+)$/);
  if (!match) return;

  const chatJid = match[1] ?? "";
  // index şu an kullanılmıyor ama ileride mesaj geçmişi için gerekebilir
  const _index = parseInt(match[2] ?? "0", 10);
  const userId = ctx.from?.id ?? 0;

  // Mesajı bul
  const msg = cachedAnalysis.find((m) => m.chatJid === chatJid);
  if (!msg) {
    await ctx.editMessageText("❌ Mesaj bulunamadı.", { parse_mode: "HTML" });
    return;
  }

  // Reply state'i kaydet
  replyStates.set(userId, {
    chatJid,
    chatName: msg.chatName,
    messageId: ctx.callbackQuery.message?.message_id ?? 0,
  });

  await ctx.editMessageText(formatReplyPrompt(msg), {
    parse_mode: "HTML",
    reply_markup: getReplyKeyboard(),
  });
});

bot.callbackQuery("reply_cancel", async (ctx) => {
  await ctx.answerCallbackQuery("❌ İptal edildi");

  const userId = ctx.from?.id ?? 0;
  replyStates.delete(userId);

  // Özete geri dön
  const summary = await generateSummary(cachedAnalysis);

  await ctx.editMessageText(formatSummaryMessage(summary), {
    parse_mode: "HTML",
    reply_markup: getCategoryKeyboard(summary),
  });
});

// ============ MOOD CALLBACK HANDLER ============

bot.callbackQuery(/^mood_(great|neutral|low)$/, async (ctx) => {
  const data = ctx.callbackQuery.data;
  const moodMap: Record<string, string> = { mood_great: "great", mood_neutral: "neutral", mood_low: "low" };
  const mood = moodMap[data];
  if (!mood) return;

  const userId = ctx.from?.id ?? 0;
  try {
    const { getMoodTrackingService } = await import("../services/mood-tracking.ts");
    const moodService = await getMoodTrackingService(userId);
    moodService.recordMood({
      mood: mood as "great" | "neutral" | "low",
      energy: mood === "great" ? 4 : mood === "neutral" ? 3 : 2,
      source: "explicit",
    });
    await ctx.answerCallbackQuery({ text: "Kaydedildi!" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch (err) {
    console.error("[MoodCallback] Failed:", err);
    await ctx.answerCallbackQuery({ text: "Hata olustu" });
  }
});

// ============ CATCH-ALL CALLBACK HANDLER ============
// Cortex'in gönderdiği free-form butonlar buraya düşer.
// Buton metnini kullanıcıdan gelen mesaj gibi Cortex'e iletir.

bot.callbackQuery(/.+/, async (ctx) => {
  const userId = ctx.from?.id ?? 0;
  const data = ctx.callbackQuery.data;

  // Spinner'ı kapat
  await ctx.answerCallbackQuery();

  if (!isAuthorized(userId)) return;

  console.log(`[Telegram] Unhandled callback from ${userId}: "${data}"`);

  // Button'ları kaldır — tıklandıktan sonra kaybolsun
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch { /* mesaj zaten silinmiş veya düzenlenemiyor */ }

  recordInteraction(userId);

  // Seçimi kullanıcı mesajı gibi göster
  await ctx.reply(`💬 ${data}`);

  await ctx.replyWithChatAction("typing");

  const response = await think(userId, data);
  if (response.content) {
    const { text: cleanContent, suggestions } = parseSuggestions(response.content);
    const replyMarkup = buildSuggestionKeyboard(suggestions);
    try {
      await ctx.reply(cleanContent, {
        parse_mode: "HTML",
        ...(replyMarkup && { reply_markup: replyMarkup }),
      });
    } catch {
      await ctx.reply(cleanContent, {
        ...(replyMarkup && { reply_markup: replyMarkup }),
      });
    }
  }
});

// ============ SES MESAJI HANDLER ============

bot.on("message:voice", async (ctx) => {
  const userId = ctx.from?.id ?? 0;

  if (!isAuthorized(userId)) {
    console.log(`Yetkisiz ses mesajı: ${userId}`);
    return;
  }

  // Record interaction for Living Assistant
  recordInteraction(userId);

  // Check if Gemini API key is configured
  if (!config.GEMINI_API_KEY) {
    await ctx.reply("❌ Ses tanıma yapılandırılmamış (GEMINI_API_KEY eksik)");
    return;
  }

  await ctx.replyWithChatAction("typing");

  try {
    // Download voice file
    const file = await ctx.getFile();
    if (!file.file_path) {
      await ctx.reply("❌ Ses dosyası indirilemedi");
      return;
    }

    const audioBuffer = await downloadTelegramFileAsBuffer(file.file_path, config.TELEGRAM_BOT_TOKEN);

    // Transcribe with Gemini
    const transcript = await transcribeAudio(audioBuffer, "audio/ogg");

    if (!transcript.trim() || transcript.includes("[ses kaydı boş veya anlaşılmıyor]")) {
      await ctx.reply("Ses anlasilamadi, tekrar dener misin?");
      return;
    }

    console.log(`[Voice] ${userId}: "${transcript.slice(0, 50)}..."`);

    // Process transcribed text as normal message
    await ctx.replyWithChatAction("typing");
    const voiceTypingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);
    let response;
    try {
      response = await think(userId, transcript);
    } finally {
      clearInterval(voiceTypingInterval);
    }

    // Show transcript and response (with suggestion buttons)
    const { text: cleanVoice, suggestions: voiceSuggestions } = parseSuggestions(response.content);
    const voiceKeyboard = buildSuggestionKeyboard(voiceSuggestions);
    const message = `🎤 <i>${transcript}</i>\n\n${cleanVoice}`;

    try {
      await ctx.reply(message, {
        parse_mode: "HTML",
        ...(voiceKeyboard && { reply_markup: voiceKeyboard }),
      });
    } catch {
      await ctx.reply(`🎤 ${transcript}\n\n${cleanVoice}`, {
        ...(voiceKeyboard && { reply_markup: voiceKeyboard }),
      });
    }

    console.log(
      `[${userId}] 🎤 ${transcript.slice(0, 30)}... -> ${response.inputTokens}/${response.outputTokens} tokens`
    );
  } catch (error) {
    console.error("Ses işleme hatası:", error);
    await ctx.reply(`❌ Ses işlenemedi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
  }
});

// ============ RESİM MESAJI HANDLER ============

bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id ?? 0;

  if (!isAuthorized(userId)) {
    console.log(`Yetkisiz erişim denemesi: ${userId}`);
    return;
  }

  // Record interaction for Living Assistant
  recordInteraction(userId);

  try {
    const processingMsg = await ctx.reply("🖼️ Resim işleniyor...");

    // En yüksek kaliteli versiyonu al
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo?.file_id) {
      await ctx.reply("Resim alınamadı!");
      return;
    }

    // Resmi buffer olarak indir
    const file = await bot.api.getFile(photo.file_id);
    const filePath = file.file_path;
    if (!filePath) {
      await ctx.reply("Resim dosya yolu alınamadı!");
      return;
    }

    // Dosyayı buffer olarak indir
    const imageBuffer = await downloadTelegramFileAsBuffer(filePath, config.TELEGRAM_BOT_TOKEN);

    // Buffer'ı base64'e çevir
    const base64Image = imageBuffer.toString("base64");

    // Dosya uzantısına göre media type belirle
    const extension = filePath.split(".").pop()?.toLowerCase() || "jpg";
    const mediaTypeMap: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mediaType = mediaTypeMap[extension] || "image/jpeg";

    // Caption varsa ekle
    const caption = ctx.message.caption || "";
    const prompt = caption
      ? `Kullanıcı bu resmi gönderdi ve şunu söyledi: "${caption}"\n\nResmi analiz et ve cevap ver.`
      : "Kullanıcı bu resmi gönderdi. Resimde ne görüyorsun? Detaylı açıkla.";

    // Multimodal mesaj oluştur
    const multimodalMessage: MultimodalMessage = {
      text: prompt,
      images: [
        {
          data: base64Image,
          mediaType: mediaType,
        },
      ],
    };

    // AI'a gönder (multimodal olarak)
    await userManager.ensureUser(userId);
    const response = await think(userId, multimodalMessage);

    // Geçici mesajı sil
    try {
      await bot.api.deleteMessage(userId, processingMsg.message_id);
    } catch {}

    const { text: cleanPhoto, suggestions: photoSuggestions } = parseSuggestions(response.content);
    const photoKeyboard = buildSuggestionKeyboard(photoSuggestions);
    try {
      await ctx.reply(cleanPhoto, {
        parse_mode: "HTML",
        ...(photoKeyboard && { reply_markup: photoKeyboard }),
      });
    } catch {
      await ctx.reply(cleanPhoto, {
        ...(photoKeyboard && { reply_markup: photoKeyboard }),
      });
    }

  } catch (error) {
    console.error("Photo handler error:", error);
    await ctx.reply("❌ Resim işlenirken hata oluştu!");
  }
});

// ============ KONUM MESAJI HANDLER ============

async function handleLocationUpdate(userId: number, latitude: number, longitude: number, isLive: boolean, isUpdate: boolean) {
  const locationType = isLive ? "canlı konum" : "konum";
  const updateNote = isUpdate ? " (güncelleme)" : "";

  const locationText = `Kullanıcı Telegram'dan ${locationType} paylaştı${updateNote}: latitude=${latitude}, longitude=${longitude}

Bu konumu analiz et:
1. Reverse geocode yaparak adresini bul
2. Kullanıcıya kısaca nerede olduğunu söyle (sadece adres, kısa)
3. Eğer bağlamda konum kaydetme/mesafe hesaplama varsa o bağlamda kullan`;

  await userManager.ensureUser(userId);
  const response = await think(userId, locationText);
  return response.content;
}

bot.on("message:location", async (ctx) => {
  const userId = ctx.from?.id ?? 0;

  if (!isAuthorized(userId)) {
    console.log(`Yetkisiz erişim denemesi: ${userId}`);
    return;
  }

  recordInteraction(userId);

  try {
    const { latitude, longitude, live_period } = ctx.message.location;
    const isLive = !!live_period;

    if (isLive) {
      // Live location — sadece cache'e yaz, agent'ı meşgul etme
      liveLocationCache.set(userId, { latitude, longitude, updatedAt: new Date() });
      console.log(`[LiveLocation] ${userId} started: ${latitude},${longitude}`);
      return;
    }

    // Normal tek seferlik konum — AI'a gönder
    const content = await handleLocationUpdate(userId, latitude, longitude, false, false);

    try {
      await ctx.reply(content, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(content);
    }

    console.log(`[Location] ${userId}: ${latitude},${longitude}`);
  } catch (error) {
    console.error("Location handler error:", error);
    await ctx.reply("❌ Konum işlenirken hata oluştu!");
  }
});

// Live location güncellemeleri — sadece cache'e yaz, agent'ı meşgul etme
bot.on("edited_message:location", (ctx) => {
  const userId = ctx.from?.id ?? 0;

  if (!isAuthorized(userId)) return;

  try {
    const location = ctx.editedMessage.location;
    if (!location?.live_period) return; // Sadece aktif live location

    const { latitude, longitude } = location;

    liveLocationCache.set(userId, { latitude, longitude, updatedAt: new Date() });
    console.log(`[LiveLocation] ${userId} cached: ${latitude},${longitude}`);

  } catch (error) {
    console.error("Live location update error:", error);
  }
});

// ============ MESAJ HANDLER (AI Sohbet) ============

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id ?? 0;

  if (!isAuthorized(userId)) {
    console.log(`Yetkisiz erişim denemesi: ${userId}`);
    return;
  }

  // Record interaction for Living Assistant
  recordInteraction(userId);

  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // ============ CEVAPLAMA MODU KONTROLÜ ============
  const replyState = replyStates.get(userId);
  if (replyState) {
    // Kullanıcı cevaplama modunda, mesajı WhatsApp'a gönder
    try {
      const outboxId = whatsappDB.sendMessage(replyState.chatJid, text);

      // State'i temizle
      replyStates.delete(userId);

      await ctx.reply(
        `✅ Mesaj gönderildi (#${outboxId})\n\n` +
        `<b>Kime:</b> ${replyState.chatName}\n` +
        `<b>Mesaj:</b> ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}\n\n` +
        `<i>Worker birkaç saniye içinde gönderecek.</i>`,
        { parse_mode: "HTML" }
      );

      console.log(`[WhatsApp Reply] ${userId} -> ${replyState.chatName}: ${text.slice(0, 30)}...`);
      return;
    } catch (error) {
      console.error("WhatsApp cevap hatası:", error);
      await ctx.reply(`❌ Mesaj gönderilemedi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
      replyStates.delete(userId);
      return;
    }
  }

  // ============ NORMAL AI SOHBET ============
  // Cortex çalışırken sürekli "typing" göster (her 4s yenile)
  await ctx.replyWithChatAction("typing");
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  try {
    const response = await think(userId, text);
    clearInterval(typingInterval);

    const { text: cleanContent, suggestions } = parseSuggestions(response.content);
    const replyMarkup = buildSuggestionKeyboard(suggestions);

    // Try Markdown first, fallback to plain text if parsing fails
    try {
      await ctx.reply(cleanContent, {
        parse_mode: "Markdown",
        ...(replyMarkup && { reply_markup: replyMarkup }),
      });
    } catch (markdownError) {
      // Markdown parsing failed (tables, unclosed entities, etc.)
      console.warn("[Telegram] Markdown parse failed, sending as plain text");
      await ctx.reply(cleanContent, {
        ...(replyMarkup && { reply_markup: replyMarkup }),
      });
    }

    console.log(
      `[${userId}] ${text.slice(0, 30)}... -> ${response.inputTokens}/${response.outputTokens} tokens | $${response.costUsd.toFixed(4)}`
    );

    // Record activity for pattern learning
    recordUserActivity(userId);

    // Extract mood from message (async, non-blocking)
    extractMoodFromMessage(userId, text, response.content).catch((err) => {
      console.warn("[Telegram] Mood extraction failed:", err);
    });
  } catch (error) {
    clearInterval(typingInterval);
    console.error("Chat hatası:", error);
    const errorMessage = error instanceof Error ? error.message : "Bilinmeyen hata";
    await ctx.reply(`❌ Hata: ${errorMessage}`);
  }
});

// ============ HATA YAKALAMA ============

bot.catch((err) => {
  console.error("Bot hatası:", err);
});

// ============ EXPORT ============

export async function startBot(): Promise<void> {
  console.log("Telegram botu başlatılıyor...");

  // Initialize permission system for tool approvals via Telegram
  initPermissions(bot);
  console.log(`[Bot] Permission mode: ${config.PERMISSION_MODE}`);

  // Telegram'a komutları kaydet (slash menüsü için)
  // Not: Hafıza, hedef, hatırlatıcı ve profil komutları kaldırıldı
  // Agent SDK MCP tools ile doğal dil üzerinden yapılıyor
  await bot.api.setMyCommands([
    // Temel
    { command: "start", description: "Botu başlat" },
    { command: "help", description: "Yardım ve komut listesi" },
    { command: "status", description: "Bot ve session durumu" },
    { command: "clear", description: "Konuşma geçmişini temizle" },
    { command: "restart", description: "Botu yeniden başlat" },
    { command: "web", description: "Web arayüzü linki al" },

    // Ayarlar
    { command: "persona", description: "Persona ayarlarını görüntüle" },
    { command: "mode", description: "Permission modunu değiştir" },

    // Session
    { command: "phase", description: "Session phase durumu / override" },

    // WhatsApp
    { command: "scan", description: "WhatsApp mesajlarını tara" },
    { command: "reply", description: "WhatsApp'a cevap yaz" },
  ]);

  // Heartbeat: bot started
  heartbeat("telegram_bot", { event: "started" });

  // Periodic heartbeat for telegram bot
  telegramHeartbeatInterval = setInterval(() => {
    heartbeat("telegram_bot", { event: "tick" });
  }, 10_000); // Every 10 seconds

  // Grammy Runner kullan - concurrent processing için
  // Bu sayede permission callback'leri agent çalışırken de alınabilir
  const runner = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "edited_message", "callback_query", "inline_query"],
      },
    },
  });

  // Bot info'yu al ve logla
  const botInfo = await bot.api.getMe();
  console.log(`Bot başlatıldı: @${botInfo.username}`);

  // WhatsApp durumunu kontrol et
  const waStatus = whatsappDB.getWorkerStatus();
  if (waStatus.connected) {
    console.log(`WhatsApp bağlı: ${waStatus.user}`);
  } else {
    console.log("WhatsApp worker bağlı değil!");
  }

  // Startup notification - agent'a sistem mesajı gönder (son konuşma özeti ile)
  // Clear session first so startup doesn't resume old "cobrain-restart" session
  const userId = config.MY_TELEGRAM_ID;
  console.log(`[Startup] Sending restart notification to user ${userId}`);
  clearSession(userId)
    .then(() => getStartupContext(userId))
    .then((contextSummary) => {
      const contextPart = contextSummary ? `\n\nSon konuşma özeti:\n${contextSummary}` : "";
      const startupMsg = `[SYSTEM] Bot yeniden başlatıldı.${contextPart}\n\nÖNEMLİ: Bu bir startup mesajıdır. cobrain-restart veya herhangi bir restart komutu ÇALIŞTIRMA.\n\nŞimdi sırayla şunları yap:\n1. recall("all") çağır — hafızanı yükle\n2. Telegram'a kısa özet gönder (max 5 satır): geri döndüğünü bildir, önemli bekleyen şeyler varsa listele`;
      return think(userId, startupMsg);
    })
    .then((response) => {
      console.log(`[Startup] Agent response: ${response.content.slice(0, 50)}...`);
      const { text: startupText, suggestions: startupSuggestions } = parseSuggestions(response.content);
      const startupKeyboard = buildSuggestionKeyboard(startupSuggestions);
      bot.api.sendMessage(userId, startupText, {
        ...(startupKeyboard && { reply_markup: startupKeyboard }),
      })
        .then(() => console.log(`[Startup] Message sent`))
        .catch((err) => console.error(`[Startup] Failed to send message:`, err));
    })
    .catch((err) => console.error(`[Startup] Agent error:`, err));

  // Graceful shutdown
  const stopRunner = () => runner.isRunning() && runner.stop();
  process.once("SIGINT", stopRunner);
  process.once("SIGTERM", stopRunner);
}

async function getStartupContext(userId: number): Promise<string | null> {
  try {
    const userDb = await userManager.getUserDb(userId);
    const memory = new UserMemory(userDb);
    const history = memory.getHistory(6); // Son 6 mesaj
    if (history.length === 0) return null;

    return history
      .filter((m) => !m.content.toLowerCase().includes("cobrain-restart"))
      .map((m) => `${m.role === "user" ? "Kullanıcı" : "Cobrain"}: ${m.content.slice(0, 150)}`)
      .join("\n");
  } catch {
    return null;
  }
}

export function stopBot(): Promise<void> {
  console.log("Bot durduruluyor...");
  clearAllPending(); // Deny all pending permission requests
  if (telegramHeartbeatInterval) {
    clearInterval(telegramHeartbeatInterval);
    telegramHeartbeatInterval = null;
  }
  whatsappDB.close();
  return bot.stop();
}

export { bot };

import { Bot } from "grammy";
import { config } from "../config.ts";
import { think, memory, clearSession } from "../brain/index.ts";
import { whatsappDB, type PendingChat } from "../services/whatsapp-db.ts";
import { analyzeMessages, generateSummary, type MessageAnalysis } from "../services/analyzer.ts";
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

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

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
  return config.ALLOWED_USER_IDS.includes(userId);
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
    `🧠 <b>Cobrain Yardım</b>

<b>Mesaj Asistanı:</b>
/scan - WhatsApp'ta cevap bekleyenleri göster
Butonlarla detay gör, cevap önerileri al

<b>AI Sohbet:</b>
Herhangi bir mesaj yaz, AI cevaplar.
Shell komutu, dosya okuma, web arama yapabilir.

<b>WhatsApp Cevaplama:</b>
/reply [kişi] [mesaj] - Mesaj gönder`,
    { parse_mode: "HTML" }
  );
});

bot.command("status", async (ctx) => {
  if (!isAuthorized(ctx.from?.id ?? 0)) return;

  const stats = memory.getStats();
  const history = memory.getHistory(ctx.from?.id ?? 0);
  const waStats = whatsappDB.getStats();
  const waStatus = whatsappDB.getWorkerStatus();

  await ctx.reply(
    `🧠 <b>Cobrain Durum</b>

<b>Bot:</b> Aktif ✅
<b>AI:</b> Claude CLI (session-based)

<b>WhatsApp Worker:</b> ${waStatus.connected ? "Bağlı ✅" : "Bağlı değil ❌"}
${waStatus.user ? `<b>Hesap:</b> ${waStatus.user}` : ""}

<b>WhatsApp DB:</b>
• Kişiler: ${waStats.contacts}
• Sohbetler: ${waStats.chats}
• Mesajlar: ${waStats.messages}

<b>AI Bellek:</b>
• Toplam: ${stats.messageCount}
• Senin geçmişin: ${history.length}

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
  clearSession(userId); // Session ve history birlikte temizlenir
  cachedAnalysis = [];

  await ctx.reply(`🗑️ Temizlendi! Session ve sohbet geçmişi sıfırlandı.`);
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

// ============ MESAJ HANDLER (AI Sohbet) ============

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id ?? 0;

  if (!isAuthorized(userId)) {
    console.log(`Yetkisiz erişim denemesi: ${userId}`);
    return;
  }

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
  await ctx.replyWithChatAction("typing");

  try {
    const response = await think(userId, text);

    await ctx.reply(response.content, { parse_mode: "Markdown" });

    console.log(
      `[${userId}] ${text.slice(0, 30)}... -> ${response.inputTokens}/${response.outputTokens} tokens | $${response.costUsd.toFixed(4)}`
    );
  } catch (error) {
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

export function startBot(): void {
  console.log("Telegram botu başlatılıyor...");

  bot.start({
    onStart: (botInfo) => {
      console.log(`Bot başlatıldı: @${botInfo.username}`);

      // WhatsApp durumunu kontrol et
      const waStatus = whatsappDB.getWorkerStatus();
      if (waStatus.connected) {
        console.log(`WhatsApp bağlı: ${waStatus.user}`);
      } else {
        console.log("WhatsApp worker bağlı değil!");
      }
    },
  });
}

export function stopBot(): Promise<void> {
  console.log("Bot durduruluyor...");
  whatsappDB.close();
  return bot.stop();
}

export { bot };

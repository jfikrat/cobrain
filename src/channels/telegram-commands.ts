import type { Bot } from "grammy";
import { config } from "../config.ts";
import { think, clearSession, getStats, userManager, isVectorMemoryAvailable } from "../brain/index.ts";
import { whatsappDB } from "../services/whatsapp-db.ts";
import { generateSessionToken } from "../web/auth.ts";
import { isAuthorized, toPendingMessage, type TelegramContext } from "./telegram-helpers.ts";
import { analyzeMessages, generateSummary } from "../services/analyzer.ts";
import {
  formatSummaryMessage,
  getCategoryKeyboard,
} from "../services/notifier.ts";

const PERMISSION_MODE_LABELS: Record<string, string> = {
  strict: "🔒 Strict - Her tool için onay iste",
  smart: "🧠 Smart - Sadece tehlikeli işlemlerde sor",
  yolo: "🚀 YOLO - Hiçbir şey sorma",
};

export function registerCommands(bot: Bot, ctx: TelegramContext) {
  bot.command("start", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) {
      await c.reply("Bu bot özel kullanım içindir.");
      return;
    }

    await c.reply(
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

  bot.command("help", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    await c.reply(
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
/mode - Permission modunu değiştir

<b>Diğer:</b>
/status - Bot durumu
/clear - Oturumu sıfırla`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("status", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    const userId = c.from?.id ?? 0;
    const userStats = await getStats(userId);
    const waStats = whatsappDB.getStats();
    const waStatus = whatsappDB.getWorkerStatus();
    const ollamaAvailable = await isVectorMemoryAvailable();

    await c.reply(
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

  bot.command("scan", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    await c.reply("🔄 WhatsApp mesajları taranıyor...");

    try {
      const pendingChats = whatsappDB.getPendingChats(24);

      if (pendingChats.length === 0) {
        await c.reply(
          `📬 <b>Mesaj Özeti</b>

✅ Son 24 saatte cevap bekleyen mesaj yok!`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const pendingMessages = pendingChats.map(toPendingMessage);
      ctx.cachedAnalysis = await analyzeMessages(pendingMessages);
      const summary = await generateSummary(ctx.cachedAnalysis);

      await c.reply(formatSummaryMessage(summary), {
        parse_mode: "HTML",
        reply_markup: getCategoryKeyboard(summary),
      });
    } catch (error) {
      console.error("Scan hatası:", error);
      await c.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  });

  bot.command("reply", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    const args = c.message?.text?.split(" ").slice(1) || [];
    if (args.length < 2) {
      await c.reply(
        `Kullanım: /reply [kişi/numara] [mesaj]

Örnek:
/reply 5551234567 Merhaba!
/reply @ahmet Tamam, görüşürüz.`
      );
      return;
    }

    const target = args[0] ?? "";
    const message = args.slice(1).join(" ");

    let jid: string;
    if (target.startsWith("+") || /^\d+$/.test(target)) {
      const num = target.replace(/\D/g, "");
      jid = `${num}@s.whatsapp.net`;
    } else {
      const contacts = whatsappDB.searchContacts(target.replace("@", ""), 1);
      if (contacts.length === 0 || !contacts[0]) {
        await c.reply(`❌ "${target}" bulunamadı.`);
        return;
      }
      jid = contacts[0].jid;
    }

    const id = whatsappDB.sendMessage(jid, message);

    await c.reply(
      `✅ Mesaj kuyruğa eklendi (#${id})

<b>Kime:</b> ${jid.split("@")[0]}
<b>Mesaj:</b> ${message}

<i>Worker birkaç saniye içinde gönderecek.</i>`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("clear", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    const userId = c.from?.id ?? 0;
    await clearSession(userId);
    ctx.cachedAnalysis = [];

    if (config.FF_SESSION_STATE) {
      const { saveSessionState, DEFAULT_SESSION_STATE } = await import("../services/session-state.ts");
      saveSessionState(userId, { ...DEFAULT_SESSION_STATE });
    }

    await c.reply(`🗑️ Temizlendi! Session ve sohbet geçmişi sıfırlandı.`);
  });

  bot.command("phase", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    const userId = c.from?.id ?? 0;

    if (!config.FF_SESSION_STATE) {
      await c.reply("Session state devre dışı (FF_SESSION_STATE=false)");
      return;
    }

    const { getSessionState, updateSessionState } = await import("../services/session-state.ts");
    const args = c.message?.text?.split(" ").slice(1) || [];

    if (args.length === 0) {
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

      await c.reply(text, { parse_mode: "HTML" });
    } else {
      const validPhases = ["exploring", "decided", "implementing", "deployed", "archived"];
      const newPhase = args[0]!.toLowerCase();

      if (!validPhases.includes(newPhase)) {
        await c.reply(`Geçersiz phase. Geçerli değerler: ${validPhases.join(", ")}`);
        return;
      }

      updateSessionState(userId, {
        conversationPhase: newPhase as any,
        confidence: 1.0,
      });

      await c.reply(`Phase güncellendi: ${newPhase} (confidence: 100%)`);
    }
  });

  bot.command("restart", async (c) => {
    if (!isAuthorized(c.from?.id ?? 0)) return;

    await c.reply("🔄 Bot yeniden başlatılıyor...");

    setTimeout(() => {
      process.exit(0);
    }, 500);
  });

  bot.command("web", async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;

    if (!config.ENABLE_WEB_UI) {
      await c.reply("❌ Web arayüzü devre dışı.");
      return;
    }

    try {
      const token = generateSessionToken(userId);
      const url = `${config.WEB_URL}?token=${token}`;

      await c.reply(
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
      await c.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  });

  bot.command("mode", async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;

    try {
      const settings = await userManager.getUserSettings(userId);
      const currentMode = settings.permissionMode || config.PERMISSION_MODE;
      const modeLabel = PERMISSION_MODE_LABELS[currentMode] || currentMode;

      await c.reply(
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
      await c.reply(`❌ Hata: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  });

  // Handle mode change callbacks
  bot.callbackQuery(/^mode:(strict|smart|yolo)$/, async (c) => {
    const userId = c.from?.id;
    if (!userId || !isAuthorized(userId)) return;

    const mode = c.match![1] as "strict" | "smart" | "yolo";

    try {
      await userManager.updateUserSettings(userId, { permissionMode: mode });
      const modeLabel = PERMISSION_MODE_LABELS[mode];

      await c.editMessageText(
        `⚙️ *Permission Mode*\n\n` +
        `✅ Mod değiştirildi: *${modeLabel}*`,
        { parse_mode: "Markdown" }
      );
      await c.answerCallbackQuery("Mod güncellendi!");

      console.log(`[Bot] User ${userId} changed permission mode to: ${mode}`);
    } catch (error) {
      await c.answerCallbackQuery("Hata oluştu!");
    }
  });
}

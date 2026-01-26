import { InlineKeyboard } from "grammy";
import type { MessageAnalysis, DailySummary } from "./analyzer.ts";

// ============ ÖZET FORMATLARI ============

export function formatSummaryMessage(summary: DailySummary): string {
  let text = `📬 <b>Mesaj Özeti</b>\n\n`;

  if (summary.totalPending === 0) {
    return `${text}✅ Bekleyen mesaj yok!`;
  }

  text += `👤 <b>Kişisel:</b> ${summary.personalCount} mesaj bekliyor\n`;
  text += `👥 <b>Gruplar:</b> ${summary.groupCount} mesaj bekliyor\n\n`;

  if (summary.highUrgency > 0) {
    text += `🔥 <b>${summary.highUrgency}</b> acil\n`;
  }
  if (summary.mediumUrgency > 0) {
    text += `😐 <b>${summary.mediumUrgency}</b> normal\n`;
  }
  if (summary.lowUrgency > 0) {
    text += `💤 <b>${summary.lowUrgency}</b> düşük öncelik\n`;
  }

  return text;
}

export function formatDetailMessage(messages: MessageAnalysis[]): string {
  if (messages.length === 0) {
    return "✅ Bekleyen mesaj yok!";
  }

  let text = `📋 <b>Detaylı Liste</b>\n\n`;

  const grouped = {
    high: messages.filter((m) => m.urgency === "high"),
    medium: messages.filter((m) => m.urgency === "medium"),
    low: messages.filter((m) => m.urgency === "low"),
  };

  if (grouped.high.length > 0) {
    text += `🔥 <b>Acil</b>\n`;
    for (const m of grouped.high) {
      text += `├ <b>${m.chatName}</b>\n`;
      text += `│ "${m.message.slice(0, 50)}${m.message.length > 50 ? "..." : ""}"\n`;
      text += `│ 📍 ${m.topic} • ⏱ ${m.waitingMinutes} dk\n`;
      text += `└ 💬 <i>${m.suggestedReply}</i>\n\n`;
    }
  }

  if (grouped.medium.length > 0) {
    text += `😐 <b>Normal</b>\n`;
    for (const m of grouped.medium) {
      text += `├ <b>${m.chatName}</b>\n`;
      text += `│ "${m.message.slice(0, 50)}${m.message.length > 50 ? "..." : ""}"\n`;
      text += `└ 📍 ${m.topic} • ⏱ ${m.waitingMinutes} dk\n\n`;
    }
  }

  if (grouped.low.length > 0) {
    text += `💤 <b>Düşük Öncelik</b>\n`;
    for (const m of grouped.low) {
      text += `• ${m.chatName}: ${m.topic}\n`;
    }
  }

  return text;
}

export function getSummaryKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 Kişisel", "category:personal")
    .text("👥 Gruplar", "category:groups")
    .row()
    .text("🔄 Yenile", "action:refresh")
    .text("✅ Tamam", "action:dismiss");
}

export function getDetailKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("◀️ Geri", "action:summary")
    .text("🔄 Yenile", "action:refresh");
}

export function getMessageKeyboard(chatId: string, messageIndex: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Cevapla", `reply:${chatId}:${messageIndex}`)
    .text("⏭️ Atla", `skip:${messageIndex}`)
    .row()
    .text("◀️ Geri", "action:detail");
}

// ============ KİŞİSEL / GRUP FORMATLARI ============

/**
 * Tek bir mesaj kartı formatı
 */
export function formatMessageCard(msg: MessageAnalysis, _index: number): string {
  const urgencyIcon = msg.urgency === "high" ? "🔥" : msg.urgency === "medium" ? "😐" : "💤";
  const timeText = formatWaitingTime(msg.waitingMinutes);

  let card = `┌─────────────────────────────────┐\n`;
  card += `│ ${urgencyIcon} <b>${escapeHtml(msg.chatName)}</b>\n`;
  card += `│ "${escapeHtml(msg.message.slice(0, 60))}${msg.message.length > 60 ? "..." : ""}"\n`;
  card += `│ 📍 ${escapeHtml(msg.topic)} • ⏱ ${timeText}\n`;

  if (msg.suggestedReply) {
    card += `│ 💡 <i>${escapeHtml(msg.suggestedReply.slice(0, 50))}${msg.suggestedReply.length > 50 ? "..." : ""}</i>\n`;
  }

  card += `└─────────────────────────────────┘`;

  return card;
}

/**
 * Kişisel mesajlar listesi
 */
export function formatPersonalList(messages: MessageAnalysis[]): string {
  const personal = messages.filter((m) => !m.isGroup);

  if (personal.length === 0) {
    return `👤 <b>Kişisel Mesajlar</b>\n\n✅ Kişisel mesaj yok!`;
  }

  let text = `👤 <b>Kişisel Mesajlar (${personal.length})</b>\n\n`;

  for (let i = 0; i < personal.length; i++) {
    const msg = personal[i];
    if (msg) {
      text += formatMessageCard(msg, i) + "\n\n";
    }
  }

  return text;
}

/**
 * Grup mesajları listesi
 */
export function formatGroupList(messages: MessageAnalysis[]): string {
  const groups = messages.filter((m) => m.isGroup);

  if (groups.length === 0) {
    return `👥 <b>Grup Mesajları</b>\n\n✅ Grup mesajı yok!`;
  }

  let text = `👥 <b>Grup Mesajları (${groups.length})</b>\n\n`;

  for (let i = 0; i < groups.length; i++) {
    const msg = groups[i];
    if (msg) {
      text += formatMessageCard(msg, i) + "\n\n";
    }
  }

  return text;
}

/**
 * Cevaplama modu formatı
 */
export function formatReplyPrompt(msg: MessageAnalysis): string {
  let text = `💬 <b>${escapeHtml(msg.chatName)}</b>'a cevap yaz:\n\n`;
  text += `<b>Son mesajı:</b> "${escapeHtml(msg.message.slice(0, 100))}${msg.message.length > 100 ? "..." : ""}"\n\n`;

  if (msg.suggestedReply) {
    text += `<b>Önerilen:</b> <i>"${escapeHtml(msg.suggestedReply)}"</i>\n\n`;
  }

  text += `Cevabını yaz ve gönder:`;

  return text;
}

// ============ YENİ KEYBOARD'LAR ============

/**
 * Kişisel/Grup seçimi için kategori keyboard'u
 */
export function getCategoryKeyboard(summary: DailySummary): InlineKeyboard {
  return new InlineKeyboard()
    .text(`👤 Kişisel (${summary.personalCount})`, "category:personal")
    .text(`👥 Gruplar (${summary.groupCount})`, "category:groups")
    .row()
    .text("🔄 Yenile", "action:refresh")
    .text("✅ Tamam", "action:dismiss");
}

/**
 * Kişisel mesaj listesi keyboard'u
 */
export function getPersonalListKeyboard(messages: MessageAnalysis[]): InlineKeyboard {
  const personal = messages.filter((m) => !m.isGroup);
  const keyboard = new InlineKeyboard();

  // Her mesaj için cevapla butonu (max 5)
  for (let i = 0; i < Math.min(personal.length, 5); i++) {
    const msg = personal[i];
    if (msg) {
      keyboard.text(`💬 ${i + 1}. ${msg.chatName.slice(0, 10)}`, `reply_start:${msg.chatJid}:${i}`);
      if (i % 2 === 1) keyboard.row();
    }
  }

  keyboard.row();
  keyboard.text("◀️ Geri", "action:summary");
  keyboard.text("🔄 Yenile", "action:refresh");

  return keyboard;
}

/**
 * Grup mesaj listesi keyboard'u
 */
export function getGroupListKeyboard(messages: MessageAnalysis[]): InlineKeyboard {
  const groups = messages.filter((m) => m.isGroup);
  const keyboard = new InlineKeyboard();

  // Her mesaj için cevapla butonu (max 5)
  for (let i = 0; i < Math.min(groups.length, 5); i++) {
    const msg = groups[i];
    if (msg) {
      keyboard.text(`💬 ${i + 1}. ${msg.chatName.slice(0, 10)}`, `reply_start:${msg.chatJid}:${i}`);
      if (i % 2 === 1) keyboard.row();
    }
  }

  keyboard.row();
  keyboard.text("◀️ Geri", "action:summary");
  keyboard.text("🔄 Yenile", "action:refresh");

  return keyboard;
}

/**
 * Cevaplama modu keyboard'u
 */
export function getReplyKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("❌ İptal", "reply_cancel");
}

// ============ YARDIMCI FONKSİYONLAR ============

function formatWaitingTime(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} dk önce`;
  } else if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return `${hours} saat önce`;
  } else {
    const days = Math.floor(minutes / 1440);
    return `${days} gün önce`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

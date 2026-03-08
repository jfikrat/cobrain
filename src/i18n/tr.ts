/** Turkish locale */
export const tr: Record<string, string> = {
  // ── Notifier ──
  "notifier.cortex_working": "🧠 Cortex çalışıyor...",
  "notifier.agent_working": "🧠 {{name}} çalışıyor...",
  "notifier.error": "❌ Hata: {{message}}",
  "notifier.done": "✅ Tamamlandı ({{count}} tool, {{elapsed}}s{{cost}})",
  "notifier.truncated": "Yanıt token limiti nedeniyle kesildi",
  "notifier.stop_reason": "Durma sebebi: {{reason}}",

  // ── Tool status ──
  "tool.web_search": '🔍 Web\'de araştırma yapıyorum: "{{query}}"',
  "tool.web_fetch": "🌐 Web sayfasını okuyorum...",
  "tool.read": "📄 Dosya okuyorum: {{file}}",
  "tool.write": "✍️ Dosya yazıyorum: {{file}}",
  "tool.edit": "📝 Dosya düzenliyorum: {{file}}",
  "tool.glob": "🔎 Dosya arıyorum: {{pattern}}",
  "tool.grep": '🔍 İçerik arıyorum: "{{pattern}}"',
  "tool.memory_save": "🧠 Hafızaya kaydediyorum...",
  "tool.memory_search": '🧠 Hafızamı tarıyorum: "{{query}}"',
  "tool.sub_agent": "🚀 Yardımcı agent başlatıyorum: {{description}}",
  "tool.todo": "📋 Görev listesini güncelliyorum...",
  "tool.gdrive_scan": "📁 Google Drive'ı tarıyorum...",
  "tool.gdrive_info": "📁 Google Drive dosya bilgisi alıyorum...",
  "tool.calendar_today": "📅 Bugünkü programa bakıyorum...",
  "tool.calendar_check": "📅 Takvime bakıyorum...",
  "tool.calendar_search": "🔍 Takvimde etkinlik arıyorum...",
  "tool.calendar_add": "📅 Takvime etkinlik ekliyorum...",
  "tool.codex": "🤖 Codex ile analiz yapıyorum...",
  "tool.gemini": "🤖 Gemini ile üretiyorum...",
  "tool.claude": "🤖 Claude Code ile görüşüyorum...",
  "tool.browser_navigate": "🌐 Sayfaya gidiyorum...",
  "tool.browser_screenshot": "📸 Ekran görüntüsü alıyorum...",
  "tool.browser_click": "👆 Elemente tıklıyorum...",
  "tool.browser_type": "⌨️ Metin yazıyorum...",
  "tool.wa_send": "💬 WhatsApp mesajı gönderiyorum...",
  "tool.wa_read": "💬 WhatsApp mesajlarını okuyorum...",
  "tool.wa_chats": "💬 WhatsApp sohbetlerini listeliyorum...",
  "tool.wa_contacts": "📇 WhatsApp kişilerini arıyorum...",
  "tool.gmail_inbox": "📬 Gmail gelen kutusuna bakıyorum...",
  "tool.gmail_search": '🔍 Gmail\'de arıyorum: "{{query}}"',
  "tool.gmail_read": "📧 Maili okuyorum...",
  "tool.gmail_send": '📤 Mail gönderiyorum: "{{subject}}"',
  "tool.gateway_call": "🔌 {{service}}/{{tool}}",
  "tool.fallback": "🔧 {{name}} kullanıyorum...",

  // ── Permissions ──
  "perm.title": "🔐 *Tool Onayı*",
  "perm.required": "🔐 *Tool Onayı Gerekli*",
  "perm.respond_within": "_2 dakika içinde yanıt ver_",
  "perm.approve": "✅ Onayla",
  "perm.deny": "❌ Reddet",
  "perm.deny_all": "🚫 Hepsini Reddet",
  "perm.timeout_invalid": "Zaman aşımı veya geçersiz istek",
  "perm.timeout_denied": "⏱️ _Zaman aşımı - Reddedildi_",
  "perm.approved": "✅ _Onaylandı_",
  "perm.denied": "❌ _Reddedildi_",
  "perm.file": "Dosya",
  "perm.denied_by_user": "Kullanıcı tarafından reddedildi",

  // ── Bot commands ──
  "cmd.unauthorized": "Bu bot özel kullanım içindir.",
  "cmd.start": `🧠 <b>Cobrain</b> — Kişisel AI Asistan\n\n<b>Hızlı Kurulum:</b>\n1. /lang — Dilini seç\n2. Kendini tanıt (isim, meslek, ilgi alanları)\n3. Sohbete başla!\n\nTüm komutlar için /help yaz.`,
  "cmd.help": `🧠 <b>Cobrain Yardım</b>\n\n<b>AI Sohbet:</b>\nDirekt mesaj yaz. Cobrain'in hafızası var, web'de gezinebilir, dosya yönetebilir ve araçları otonom kullanabilir.\n\n<b>Agent'lar:</b>\nCobrain özelleşmiş agent'lar çalıştırır (kod, araştırma, WhatsApp...). Her agent Hub grubunda kendi topic'inde çalışır.\n\n<b>Komutlar:</b>\n/status — Bot istatistikleri\n/clear — Oturumu sıfırla\n/mode — İzin modu (strict/smart/yolo)\n/lang — Dil değiştir\n/restart — Botu yeniden başlat\n\n<b>İpuçları:</b>\n• "Bunu hatırla: ..." — hafızaya kaydeder\n• "15:00'te hatırlat: ..." — hatırlatıcı kurar\n• Sesli/görsel/dosya gönder — Cobrain işler`,
  "cmd.status_title": "🧠 <b>Cobrain Durum</b>",
  "cmd.active": "Aktif ✅",
  "cmd.your_stats": "Senin İstatistiklerin",
  "cmd.messages": "Mesajlar",
  "cmd.sessions": "Oturumlar",
  "cmd.total_cost": "Toplam maliyet",
  "cmd.cleared": "🗑️ Temizlendi! Session ve sohbet geçmişi sıfırlandı.",
  "cmd.restarting": "🔄 Bot yeniden başlatılıyor...",
  "cmd.error": "❌ Hata: {{message}}",

  // ── Permission mode ──
  "mode.strict": "🔒 Strict — Her tool için onay iste",
  "mode.smart": "🧠 Smart — Sadece tehlikeli işlemlerde sor",
  "mode.yolo": "🚀 YOLO — Hiçbir şey sorma",
  "mode.current": "Mevcut",
  "mode.select": "Mod seç:",
  "mode.changed": "✅ Mod değiştirildi: *{{mode}}*",
  "mode.updated": "Mod güncellendi!",
  "mode.error": "Hata oluştu!",

  // ── Language ──
  "lang.current": "🌐 Mevcut dil: *{{lang}}*",
  "lang.select": "Dil seç:",
  "lang.changed": "🌐 Dil değiştirildi: *{{lang}}*",
  "lang.updated": "Dil güncellendi!",

  // ── Command descriptions (slash menu) ──
  "menu.start": "Botu başlat",
  "menu.help": "Yardım ve komut listesi",
  "menu.status": "Bot ve session durumu",
  "menu.clear": "Konuşma geçmişini temizle",
  "menu.restart": "Botu yeniden başlat",
  "menu.mode": "Permission modunu değiştir",
  "menu.lang": "Dil değiştir",

  // ── Daily summary ──
  "daily.greeting": "Günaydın! Günlük Özet",
  "daily.today_reminders": "Bugünkü Hatırlatıcılar",
  "daily.no_reminders": "Bugün için hatırlatıcı yok",
  "daily.pending_count": "Bekleyen hatırlatıcı:",
  "daily.goodbye": "İyi günler!",
  "daily.reminder_trigger": '[SİSTEM] Hatırlatıcı tetiklendi: "{{action}}"\n\nBu hatırlatıcıyı şimdi yerine getir. Gerekli aksiyonu al (mesaj gönder, bilgi ver, vb.) ve kullanıcıya bildir.',

  // ── Interaction log ──
  "log.no_interactions": '"{{agentId}}" ajanı için henüz etkileşim kaydı yok.',
  "log.last_interactions": "Son {{count}} etkileşim ({{agentId}}):",

  // ── Router ──
  "router.fallback": "Sen Cobrain'in {{name}} agent'ısın. Kısa, doğal cevaplar ver.",
};

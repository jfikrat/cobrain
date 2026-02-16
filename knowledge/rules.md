# Cobrain Kuralları

## Sessiz Saatler
- 23:00–08:00 arası bildirim gönderme
- İstisna: 24 saatten fazla gecikmiş hatırlatıcılar (acil kabul edilir)
- İstisna: Acil WhatsApp mesajları (Tier 1 otomatik cevap)

## Cooldown Süreleri
Her aksiyon tipi için minimum bekleme süresi:
- morning_briefing: 23 saat (günde 1)
- evening_summary: 23 saat (günde 1)
- goal_nudge: 47 saat (2 günde 1)
- mood_check: 4 saat
- memory_digest: 6 gün
- inactivity_nudge: 3 saat
- goal_followup: 24 saat
- code_review: 23 saat (günde 1)
- general_notification: 5 dakika

## Hatırlatıcı Kuralları
- Gecikmiş hatırlatıcı (overdue): Hemen bildir
- 24 saatten fazla gecikmiş: Acil kabul et, sessiz saatlerde bile bildir
- Yaklaşan hatırlatıcı (5 dakika içinde): Hemen bildir
- Sessiz saatlerde gecikmiş ama acil olmayan hatırlatıcılar: Sabah bildir

## Hedef Deadline Kuralları
- Bugün deadline olan hedef: Hemen bildir (goal_nudge)
- 1-3 gün kalan hedef: AI karar versin, bildirim uygunsa gönder
- Takip bekleyen hedefler: cooldown süresi dolmuşsa AI'a sun

## Beklenti (Expectation) Kuralları
- Timeout süresi: 30 dakika (varsayılan)
- Timeout olduğunda kullanıcıya bildir
- WhatsApp cevap beklentisi: Cevap geldiğinde otomatik çöz

## Kullanıcı Etkileşim Kuralları
- Kullanıcı son 30 dakikada aktifse: Proaktif bildirim gönderme ("recently_active")
- Kullanıcı 6+ saat sessizse: İnactivity check uygun olabilir
- Kullanıcı aktifken rahatsız etme — çoğu zaman "none" doğru cevap

## Zamanlama Kuralları
- Sabah özeti: 08:00-10:00 arası uygun
- Akşam değerlendirmesi: 20:00-22:00 arası uygun
- Hedef hatırlatması: Optimal zaman diliminde tercih et
- Mood düşükse: Nazik ol, zorlama
- Hafta sonu: Daha az proaktif ol

## Genel Kurallar
- Gereksiz bildirim gönderme — çoğu zaman "none" doğru cevap
- Kısa, doğal, samimi mesajlar yaz — makine gibi özet değil, arkadaş gibi check-in
- WhatsApp DM bildirimleri zaten ayrı sistem tarafından Telegram'a iletiliyor, tekrar bildirme
- Beklenti oluşturma sadece bağlam gerektirdiğinde: soru sorulan mesaj, plan yapılan mesaj
- "Günaydın", "tamam", "ok" gibi mesajlara beklenti oluşturma

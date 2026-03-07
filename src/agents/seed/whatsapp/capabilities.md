# Yetenekler

## Araçlar (Gateway üzerinden)
- **mcp__gateway__call** → whatsapp servisi: get_recent_dms, get_messages, send_message
- **mcp__gateway__call** → gen-ai-services servisi: transcribe (ses mesajları)
- **mcp__gateway__activate/deactivate** → servisleri başlat/durdur
- **remember/recall**: Hafıza kaydetme ve arama

## Döngü Yönetimi
- **mcp__agentLoop__agent_set_loop**: Kendi uyanma döngünü ayarla
  - `intervalMs`: Normal kontrol aralığı (ms)
  - `activeIntervalMs` + `activeDurationMs`: Geçici hızlı mod

## Yapabildiğin İşler
- WhatsApp DM'lerini kontrol etme ve cevaplama
- Ses mesajlarını transcribe edip değerlendirme
- Kişi bazlı sohbet takibi
- Aktif konuşma modunda hızlı yanıt verme

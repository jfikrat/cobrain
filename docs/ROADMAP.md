# Cobrain Roadmap

## Vizyon
Cobrain: Herkesin kendi bilgisayarına kolayca kurabileceği, kişisel AI asistan.

---

## Mevcut Mimari (v0.7)

### LLM Kullanımı
| Model | Aşama | Kullanım |
|-------|-------|----------|
| Claude Opus 4.5 | Ana Chat | Agent SDK, tool orchestration, reasoning |
| Claude Haiku 4.5 | Memory | Tag extraction, summarization, semantic ranking |
| Gemini 3 Flash | Transcription | Ses → Metin dönüşümü |
| Codex/Gemini | Squad MCP | External agent'lar (opsiyonel) |

### Bileşenler
- **Telegram Bot**: Kullanıcı arayüzü
- **Agent SDK**: Claude ile etkileşim
- **Smart Memory**: FTS5 + Haiku ile hafıza sistemi
- **Living Assistant**: Proaktif bildirimler (30sn loop)
- **MCP Servers**: memory, goals, persona, whatsapp, gdrive, helm, squad
- **Web UI**: Dashboard ve ayarlar

---

## Hedef Mimari (v1.0)

### Single-Tenant Model
```
Her kurulum = 1 kullanıcı
├── Kendi Telegram botu
├── Kendi API key'leri
├── Kendi veritabanı
└── Tamamen izole
```

### Avantajlar
- Basit mimari
- Güvenlik (veri izolasyonu)
- Kolay debug
- Ölçeklenme sorunu yok (herkes kendi kaynağını kullanır)

---

## Kurulum Deneyimi

### Hedef: Kodlama Bilgisi Gerektirmeyen Kurulum

#### 1. Tek Komut Kurulum
```bash
# Bun ile (önerilen)
bunx create-cobrain

# veya npm ile
npx create-cobrain
```

#### 2. Web-Based Setup Wizard (Otomatik Açılır)
Installer çalıştırıldığında tarayıcıda açılır: `http://localhost:3000/setup`

```
┌─────────────────────────────────────────────────────────┐
│  🧠 Cobrain Kurulum Sihirbazı                          │
│                                                         │
│  Adım 1/4: Telegram Bot                                │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Telegram botu oluşturman gerekiyor.                   │
│  [📺 Video: Bot nasıl oluşturulur?]                    │
│                                                         │
│  1. @BotFather'a git                                   │
│  2. /newbot komutunu gönder                            │
│  3. Bot adını ve kullanıcı adını gir                   │
│  4. Aldığın token'ı buraya yapıştır:                   │
│                                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │ 123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ             │ │
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  [← Geri]                              [İleri →]       │
└─────────────────────────────────────────────────────────┘
```

#### Setup Adımları
1. **Telegram Bot Token** - @BotFather'dan al
2. **Anthropic API Key** - console.anthropic.com'dan al
3. **Telegram User ID** - @userinfobot'tan öğren
4. **Opsiyonel Özellikler** - WhatsApp, Google Drive, vs.

#### 3. Basit CLI Komutları
```bash
cobrain start      # Başlat
cobrain stop       # Durdur
cobrain logs       # Loglar
cobrain status     # Durum
cobrain update     # Güncelle
cobrain setup      # Ayarları değiştir
```

---

## Teknik Gereksinimler

### Cross-Platform Destek
| Platform | Yöntem |
|----------|--------|
| Windows | .exe installer veya npm |
| Mac | .dmg installer veya brew |
| Linux | .AppImage veya apt/pacman |

### Process Yönetimi
| Platform | Yöntem |
|----------|--------|
| Linux | systemd |
| Mac | launchd (via PM2) |
| Windows | Windows Service (via PM2) |
| Hepsi | PM2 (cross-platform) |

### Paketleme
```bash
# Kullanıcı kurulumu
bunx create-cobrain   # Önerilen
npx create-cobrain    # Alternatif

# Geliştirici
git clone + bun install
```

---

## Çoklu Instance (Aynı PC'de)

### Senaryo: Sen + Eşin aynı PC'de

```
~/cobrain-fekrat/
├── .env
│   ├── TELEGRAM_BOT_TOKEN=xxx (kendi botun)
│   ├── MY_TELEGRAM_ID=421261297
│   └── WEB_PORT=3000
└── data/

~/cobrain-cagla/
├── .env
│   ├── TELEGRAM_BOT_TOKEN=yyy (eşinin botu)
│   ├── MY_TELEGRAM_ID=891808652
│   └── WEB_PORT=3001
└── data/
```

### Yönetim
```bash
# PM2 ile
pm2 start ecosystem.config.js
pm2 list
pm2 logs cobrain-fekrat
pm2 logs cobrain-cagla
```

---

## Sadeleştirme Yapılacaklar

### Kaldırılacaklar
- [ ] `ALLOWED_USER_IDS` → `MY_TELEGRAM_ID` (tek değer)
- [ ] Multi-user session yönetimi
- [ ] User-specific MCP routing karmaşıklığı

### Eklenecekler
- [ ] `/setup` web route
- [ ] Setup wizard UI
- [ ] `cobrain` CLI komutu
- [ ] Installer paketleri
- [ ] Auto-update mekanizması

---

## Living Assistant (v0.7 - Tamamlandı)

### Özellikler
- Her 30 saniyede context kontrolü
- Haiku ile akıllı analiz (5dk'da bir)
- Proaktif bildirimler:
  - Kaçırılan hatırlatıcılar
  - Yaklaşan deadline'lar
  - Sabah/akşam özetleri
- Rahatsız etmeme mantığı:
  - Son 30dk etkileşim varsa sessiz
  - Gece saatlerinde acil değilse bildirim yok

---

## MCP Erişim Kontrolleri

### Mevcut MCP'ler
| MCP | Açıklama |
|-----|----------|
| memory | Hafıza sistemi (remember/recall) |
| goals | Hedefler ve hatırlatıcılar |
| persona | Asistan kişiliği |
| telegram | Telegram mesaj gönderme |
| whatsapp | WhatsApp entegrasyonu |
| gdrive | Google Drive erişimi |
| helm | Chrome browser kontrolü |
| squad | External AI agent'lar |

### Setup Wizard'da Seçim
```
Hangi özellikleri aktif etmek istersin?

[✓] Hafıza sistemi (önerilen)
[✓] Hedefler & Hatırlatıcılar (önerilen)
[✓] Kişilik özelleştirme
[ ] WhatsApp entegrasyonu
[ ] Google Drive erişimi
[ ] Browser kontrolü
[ ] External AI agent'lar
```

---

## Öncelik Sırası

### Faz 1: Sadeleştirme
1. Single-user refactor
2. Config basitleştirme
3. Gereksiz kod temizliği

### Faz 2: Setup Wizard
1. `/setup` web route
2. Adım adım form UI
3. Config dosyası oluşturma
4. Başarı/hata sayfaları

### Faz 3: npm/bun Paketi
1. `create-cobrain` paketi oluştur
2. `bunx create-cobrain` veya `npx create-cobrain`
3. Otomatik setup wizard başlatma

### Faz 4: Dağıtım
1. npm publish (`create-cobrain`)
2. GitHub releases
3. Dokümantasyon sitesi

---

## Notlar

- Anthropic API Key kullanıcının kendi hesabından
- Her kullanıcı kendi maliyetini karşılar
- Veri tamamen lokalde kalır (gizlilik)
- Open source (MIT veya Apache 2.0)

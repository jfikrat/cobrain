import { GoogleGenerativeAI } from "@google/generative-ai";
import { join } from "node:path";
import { config } from "../config.ts";

/**
 * Transcription System Prompt — kısa ve net.
 * Uzun prompt kısa seslerde halüsinasyona sebep oluyor.
 */
const TRANSCRIPTION_SYSTEM_PROMPT = `Sen bir speech-to-text motorusun. Ses kaydını metne çevir.

KURALLAR:
- SADECE söylenen kelimeleri yaz. Başka hiçbir şey ekleme.
- Yorum yapma, cevap verme, açıklama ekleme, giriş cümlesi yazma.
- Türkçe karakterleri doğru kullan (ç, ğ, ı, ö, ş, ü, İ).
- Türkçe-İngilizce karma konuşmalarda her kelimeyi söylendiği dilde yaz.
- İngilizce kelimelere Türkçe ek eklerken apostrof kullan (API'ye, bug'ı).
- Kısaltmaları büyük harf yaz (API, URL, JSON).
- Anlaşılmayan kısımları [anlaşılmıyor] olarak işaretle.
- Ses boşsa veya konuşma yoksa sadece yaz: [ses kaydı boş veya anlaşılmıyor]`;

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: config.TRANSCRIPTION_MODEL,
  systemInstruction: TRANSCRIPTION_SYSTEM_PROMPT,
});

const TRANSCRIPTION_USER_PROMPT = `Transkript et.`;

/**
 * Ses buffer'ının başına 3 saniyelik sessizlik ekler (FFmpeg concat)
 * Kısa ses kayıtlarında Gemini halüsinasyonunu önlemek için
 */
async function prependSilence(audioBuffer: Buffer): Promise<Buffer> {
  const silencePath = join(process.cwd(), "data", "silence-3s.ogg");
  const uid = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tmpInput = join("/tmp", `cobrain-audio-${uid}.ogg`);
  const tmpOutput = join("/tmp", `cobrain-audio-${uid}-out.ogg`);

  console.log(`[Transcribe] prependSilence called, audioSize=${audioBuffer.length}, silencePath=${silencePath}`);

  try {
    // Silence dosyasi var mi kontrol et
    const silenceFile = Bun.file(silencePath);
    if (!(await silenceFile.exists())) {
      console.warn(`[Transcribe] Silence file not found: ${silencePath}`);
      return audioBuffer;
    }

    await Bun.write(tmpInput, audioBuffer);

    const proc = Bun.spawn([
      "ffmpeg", "-y",
      "-i", silencePath,
      "-i", tmpInput,
      "-filter_complex", "concat=n=2:v=0:a=1",
      "-c:a", "libopus", "-b:a", "32k",
      tmpOutput,
    ], { stdout: "ignore", stderr: "ignore" });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn(`[Transcribe] FFmpeg concat failed (exit=${exitCode}), using original audio`);
      return audioBuffer;
    }

    const outputFile = Bun.file(tmpOutput);
    const result = Buffer.from(await outputFile.arrayBuffer());
    console.log(`[Transcribe] Silence prepended successfully, outputSize=${result.length}`);
    return result;
  } catch (err) {
    console.warn("[Transcribe] Silence prepend failed:", err);
    return audioBuffer;
  } finally {
    try {
      const fs = await import("node:fs/promises");
      await fs.unlink(tmpInput).catch(() => {});
      await fs.unlink(tmpOutput).catch(() => {});
    } catch {}
  }
}

/**
 * Ses dosyasını Gemini ile metne çevirir
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = "audio/ogg"
): Promise<string> {
  const SHORT_AUDIO_THRESHOLD = 50 * 1024; // 50KB (~3s)
  let processedBuffer: Buffer;
  let effectiveMime = mimeType;

  if (audioBuffer.length < SHORT_AUDIO_THRESHOLD) {
    processedBuffer = await prependSilence(audioBuffer);
    if (processedBuffer !== audioBuffer) {
      effectiveMime = "audio/ogg";
    }
  } else {
    processedBuffer = audioBuffer;
  }

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: effectiveMime,
        data: processedBuffer.toString("base64"),
      },
    },
    {
      text: TRANSCRIPTION_USER_PROMPT,
    },
  ]);

  const transcript = result.response.text().trim();

  // Post-processing: Gereksiz prefix'leri temizle
  return cleanTranscriptOutput(transcript);
}

/**
 * Transcript çıktısını temizler ve halüsinasyon tespiti yapar
 * Gemini kısa seslerde system prompt'u tekrarlayabiliyor veya uydurma içerik üretebiliyor
 */
function cleanTranscriptOutput(text: string): string {
  // 1. Halüsinasyon tespiti — system/user prompt tekrarı veya meta-commentary
  const hallucinationMarkers = [
    "speech-to-text",
    "ses kaydını metne çevir",
    "SADECE söylenen kelimeleri",
    "yorum yapma, cevap verme",
    "transkript et.",
    "ses kaydı boş veya anlaşılmıyor]", // marker without opening bracket — partial match
    "açıklama ekleme, giriş cümlesi",
    "apostrof kullan",
    "anlaşılmayan kısımları",
    "kısaltmaları büyük harf",
    // Generic hallucination patterns (model talking about itself)
    "bu ses kaydında",
    "ses kaydı şunları içeriyor",
    "transkripsiyon aracı",
    "konuşmacı şunları söylüyor",
  ];

  const lowerText = text.toLowerCase();
  const matchCount = hallucinationMarkers.filter(m => lowerText.includes(m.toLowerCase())).length;

  if (matchCount >= 2) {
    console.warn(`[Transcribe] Hallucination detected (${matchCount} markers matched), returning empty`);
    return "[ses kaydı boş veya anlaşılmıyor]";
  }

  // 2. Çok uzun çıktı tespiti — kısa ses kaydından uzun metin gelmesi şüpheli
  // (bu fonksiyon audioSize bilmez, ama 500+ karakter transcript genelde halüsinasyon)
  if (text.length > 500 && (
    text.includes("function ") ||
    text.includes("import ") ||
    text.includes("const ") ||
    text.includes("class ") ||
    text.includes("export ")
  )) {
    console.warn(`[Transcribe] Suspicious code-like transcript (${text.length} chars), possible hallucination`);
    // Bunu engelleme, sadece logla — gerçek kod konuşması olabilir
  }

  // 3. Yaygın gereksiz prefix'leri kaldır
  const unwantedPrefixes = [
    /^(İşte transkript:?\s*)/i,
    /^(Transkript:?\s*)/i,
    /^(Ses kaydı:?\s*)/i,
    /^(Ses kaydında:?\s*)/i,
    /^(Konuşma:?\s*)/i,
    /^(Metin:?\s*)/i,
    /^(Here'?s the transcript:?\s*)/i,
    /^(Transcript:?\s*)/i,
    /^(Audio transcript:?\s*)/i,
    /^(The audio says:?\s*)/i,
    /^["']|["']$/g, // Başta ve sonda tırnak işaretleri
  ];

  let cleaned = text;
  for (const pattern of unwantedPrefixes) {
    cleaned = cleaned.replace(pattern, '');
  }

  return cleaned.trim();
}

/**
 * Telegram'dan ses dosyası indirir (Buffer olarak)
 */
export async function downloadTelegramFileAsBuffer(
  filePath: string,
  botToken: string
): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const response = await fetch(url);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Telegram'dan dosya indirir ve belirtilen yola kaydeder
 */
export async function downloadTelegramFile(
  api: any,
  fileId: string,
  savePath: string
): Promise<void> {
  const fs = await import("fs/promises");

  // File path'i al
  const file = await api.getFile(fileId);
  const filePath = file.file_path;

  // Dosyayı indir - api.token yerine config'den token al
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Dosyaya kaydet
  await fs.writeFile(savePath, buffer);
}

import { chatOneShot } from "../brain/claude.ts";
import type { PendingMessage } from "./whatsapp.ts";

export interface MessageAnalysis {
  chatName: string;
  senderName: string;
  message: string;
  urgency: "high" | "medium" | "low";
  topic: string;
  suggestedReply: string;
  waitingMinutes: number;
  isGroup: boolean;
  chatJid: string;
}

export interface DailySummary {
  totalPending: number;
  highUrgency: number;
  mediumUrgency: number;
  lowUrgency: number;
  personalCount: number;
  groupCount: number;
  messages: MessageAnalysis[];
  summaryText: string;
}

const ANALYSIS_PROMPT = `Sen bir mesaj analiz asistanısın. Gelen mesajları analiz edip JSON formatında yanıt ver.

Her mesaj için:
1. urgency: "high" (acil/önemli), "medium" (normal), "low" (düşük öncelik)
2. topic: Kısa konu özeti (max 5 kelime)
3. suggestedReply: Önerilen kısa cevap

Sadece JSON array döndür, başka bir şey yazma.`;

export async function analyzeMessages(messages: PendingMessage[]): Promise<MessageAnalysis[]> {
  if (messages.length === 0) return [];

  const messagesText = messages.map((m, i) =>
    `${i + 1}. [${m.chatName}] ${m.senderName}: "${m.message}" (${m.waitingMinutes} dk önce)`
  ).join("\n");

  const prompt = `${ANALYSIS_PROMPT}\n\nBu mesajları analiz et:\n\n${messagesText}`;

  try {
    const response = await chatOneShot(prompt);

    // JSON'u parse et
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[Analyzer] JSON bulunamadı, raw:", response.slice(0, 200));
      throw new Error("JSON bulunamadı");
    }

    const analyzed = JSON.parse(jsonMatch[0]) as {
      urgency: "high" | "medium" | "low";
      topic: string;
      suggestedReply: string;
    }[];

    return messages.map((m, i) => ({
      chatName: m.chatName,
      senderName: m.senderName,
      message: m.message,
      urgency: analyzed[i]?.urgency || "medium",
      topic: analyzed[i]?.topic || "Bilinmeyen",
      suggestedReply: analyzed[i]?.suggestedReply || "",
      waitingMinutes: m.waitingMinutes,
      isGroup: m.isGroup,
      chatJid: m.chatId,
    }));
  } catch (error) {
    console.error("[Analyzer] Hata:", error);

    // Fallback: analiz yapılamadıysa default değerlerle dön
    return messages.map((m) => ({
      chatName: m.chatName,
      senderName: m.senderName,
      message: m.message,
      urgency: "medium" as const,
      topic: "Bilinmeyen",
      suggestedReply: "",
      waitingMinutes: m.waitingMinutes,
      isGroup: m.isGroup,
      chatJid: m.chatId,
    }));
  }
}

export async function generateSummary(analyses: MessageAnalysis[]): Promise<DailySummary> {
  const highUrgency = analyses.filter((a) => a.urgency === "high").length;
  const mediumUrgency = analyses.filter((a) => a.urgency === "medium").length;
  const lowUrgency = analyses.filter((a) => a.urgency === "low").length;
  const personalCount = analyses.filter((a) => !a.isGroup).length;
  const groupCount = analyses.filter((a) => a.isGroup).length;

  let summaryText = `📬 Mesaj Özeti\n\n`;
  summaryText += `Toplam: ${analyses.length} mesaj bekliyor\n`;
  summaryText += `👤 Kişisel: ${personalCount} • 👥 Grup: ${groupCount}\n\n`;

  if (highUrgency > 0) {
    summaryText += `🔥 ${highUrgency} acil\n`;
  }
  if (mediumUrgency > 0) {
    summaryText += `😐 ${mediumUrgency} normal\n`;
  }
  if (lowUrgency > 0) {
    summaryText += `💤 ${lowUrgency} düşük öncelik\n`;
  }

  return {
    totalPending: analyses.length,
    highUrgency,
    mediumUrgency,
    lowUrgency,
    personalCount,
    groupCount,
    messages: analyses,
    summaryText,
  };
}

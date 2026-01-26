import { chat, type ClaudeResponse } from "./claude.ts";
import { memory, type Message } from "../memory/sqlite.ts";

export interface ThinkResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessionId: string;
  historyLength: number;
}

export async function think(userId: number, message: string): Promise<ThinkResponse> {
  // Session ID al veya oluştur
  let sessionId = memory.getSession(userId);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    memory.setSession(userId, sessionId);
    console.log(`[Session] Yeni session oluşturuldu: ${sessionId.slice(0, 8)}... (user: ${userId})`);
  }

  // Claude CLI çağır
  const response = await chat(sessionId, message);

  // History'ye ekle (backup amaçlı)
  memory.addMessage(userId, "user", message);
  memory.addMessage(userId, "assistant", response.content);

  const history = memory.getHistory(userId);

  return {
    content: response.content,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    sessionId: response.sessionId,
    historyLength: history.length,
  };
}

export function clearSession(userId: number): void {
  memory.clearSession(userId);
  memory.clearHistory(userId);
  console.log(`[Session] Session temizlendi (user: ${userId})`);
}

export { memory };
export type { Message, ClaudeResponse };

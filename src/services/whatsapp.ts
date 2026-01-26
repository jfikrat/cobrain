import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

export interface PendingMessage {
  id: string;
  chatId: string;
  chatName: string;
  senderName: string;
  message: string;
  timestamp: Date;
  isGroup: boolean;
  waitingMinutes: number;
}

class WhatsAppService {
  private sock: WASocket | null = null;
  private isConnected = false;
  private onQRCode: ((qr: string) => void) | null = null;
  private onConnected: (() => void) | null = null;

  async connect(authDir: string = "./data/whatsapp-auth"): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && this.onQRCode) {
        this.onQRCode(qr);
      }

      if (connection === "close") {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          DisconnectReason.loggedOut;

        console.log("[WhatsApp] Bağlantı kapandı, yeniden bağlanılıyor:", shouldReconnect);

        if (shouldReconnect) {
          this.connect(authDir);
        }
      } else if (connection === "open") {
        console.log("[WhatsApp] Bağlantı kuruldu!");
        this.isConnected = true;
        if (this.onConnected) this.onConnected();
      }
    });
  }

  setOnQRCode(callback: (qr: string) => void) {
    this.onQRCode = callback;
  }

  setOnConnected(callback: () => void) {
    this.onConnected = callback;
  }

  isReady(): boolean {
    return this.isConnected && this.sock !== null;
  }

  async getChats(): Promise<{ id: string; name: string; unreadCount: number }[]> {
    if (!this.sock) return [];

    const chats = await this.sock.groupFetchAllParticipating();
    const result: { id: string; name: string; unreadCount: number }[] = [];

    for (const [id, chat] of Object.entries(chats)) {
      result.push({
        id,
        name: chat.subject || id,
        unreadCount: 0,
      });
    }

    return result;
  }

  async getPendingMessages(): Promise<PendingMessage[]> {
    if (!this.sock) return [];

    // Not: Baileys'de mesaj geçmişi için store kullanılmalı
    // Bu basit implementasyonda sadece yeni gelen mesajları dinleyeceğiz
    const pending: PendingMessage[] = [];

    return pending;
  }

  onNewMessage(callback: (msg: PendingMessage) => void) {
    if (!this.sock) return;

    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          const chatId = msg.key.remoteJid || "";
          const isGroup = chatId.endsWith("@g.us");

          let chatName = chatId;
          let senderName = msg.pushName || "Bilinmeyen";

          if (isGroup && this.sock) {
            try {
              const metadata = await this.sock.groupMetadata(chatId);
              chatName = metadata.subject;
            } catch {
              chatName = chatId;
            }
          } else {
            chatName = senderName;
          }

          const messageText = this.extractMessageText(msg.message);

          callback({
            id: msg.key.id || "",
            chatId,
            chatName,
            senderName,
            message: messageText,
            timestamp: new Date((msg.messageTimestamp as number) * 1000),
            isGroup,
            waitingMinutes: 0,
          });
        }
      }
    });
  }

  private extractMessageText(message: proto.IMessage): string {
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return `[Resim] ${message.imageMessage.caption}`;
    if (message.imageMessage) return "[Resim]";
    if (message.videoMessage?.caption) return `[Video] ${message.videoMessage.caption}`;
    if (message.videoMessage) return "[Video]";
    if (message.audioMessage) return "[Ses]";
    if (message.documentMessage) return `[Dosya] ${message.documentMessage.fileName || ""}`;
    if (message.stickerMessage) return "[Sticker]";
    if (message.contactMessage) return "[Kişi]";
    if (message.locationMessage) return "[Konum]";
    return "[Mesaj]";
  }

  async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.sock) return false;

    try {
      await this.sock.sendMessage(chatId, { text });
      return true;
    } catch (error) {
      console.error("[WhatsApp] Mesaj gönderilemedi:", error);
      return false;
    }
  }

  disconnect() {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
      this.isConnected = false;
    }
  }
}

export const whatsappService = new WhatsAppService();

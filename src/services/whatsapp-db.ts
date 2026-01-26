/**
 * WhatsApp DB Service
 * Mevcut WhatsApp Worker'ın SQLite veritabanını okur/yazar
 * Worker zaten 7/24 çalışıyor, biz sadece DB'ye erişiyoruz
 */

import { Database } from "bun:sqlite";

const WHATSAPP_DB_PATH = process.env.WHATSAPP_DB_PATH || "/home/fekrat/baileys-test/db/whatsapp.db";

export interface Contact {
  jid: string;
  name: string | null;
  notify: string | null;
  verified_name: string | null;
  phone: string | null;
}

export interface Chat {
  jid: string;
  name: string | null;
  is_group: number;
  unread_count: number;
  last_message_timestamp: number | null;
}

export interface Message {
  id: string;
  chat_jid: string;
  sender_jid: string | null;
  content: string | null;
  message_type: string;
  timestamp: number | null;
  is_from_me: number;
}

export interface PendingChat {
  chatJid: string;
  chatName: string;
  lastMessage: string;
  lastMessageTime: Date;
  waitingMinutes: number;
  isGroup: boolean;
  senderName: string;
}

class WhatsAppDBService {
  private db: Database | null = null;
  private available: boolean = false;

  constructor() {
    // Worker DB'yi yazıyor, biz okuma + outbox yazma yapacağız
    // WAL mode sayesinde eşzamanlı erişim mümkün
    try {
      this.db = new Database(WHATSAPP_DB_PATH);
      this.db.run("PRAGMA journal_mode = WAL");
      this.available = true;
      console.log("[WhatsApp DB] Bağlandı:", WHATSAPP_DB_PATH);
    } catch (error) {
      console.log("[WhatsApp DB] Kullanılamıyor - WhatsApp özellikleri devre dışı");
      this.db = null;
      this.available = false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Cevap bekleyen sohbetleri getir
   * Son mesaj benden değilse = cevap bekliyor
   */
  getPendingChats(limitHours: number = 24): PendingChat[] {
    if (!this.db) return [];
    const cutoffTime = Math.floor(Date.now() / 1000) - (limitHours * 3600);

    // Her sohbet için son mesajı al
    const query = `
      SELECT
        m.chat_jid,
        c.name as chat_name,
        m.content,
        m.timestamp,
        m.is_from_me,
        m.sender_jid,
        ch.is_group,
        (SELECT name FROM contacts WHERE jid = m.sender_jid) as sender_name
      FROM messages m
      LEFT JOIN chats ch ON ch.jid = m.chat_jid
      LEFT JOIN contacts c ON c.jid = m.chat_jid
      WHERE m.timestamp > ?
        AND m.timestamp = (
          SELECT MAX(timestamp)
          FROM messages
          WHERE chat_jid = m.chat_jid
        )
        AND m.is_from_me = 0
        AND m.message_type != 'reaction'
      ORDER BY m.timestamp DESC
      LIMIT 50
    `;

    const rows = this.db.query<{
      chat_jid: string;
      chat_name: string | null;
      content: string | null;
      timestamp: number;
      is_from_me: number;
      sender_jid: string | null;
      is_group: number | null;
      sender_name: string | null;
    }, [number]>(query).all(cutoffTime);

    const now = Date.now();

    return rows.map((row) => ({
      chatJid: row.chat_jid,
      chatName: row.chat_name || row.sender_name || row.chat_jid.split("@")[0] || "Bilinmeyen",
      lastMessage: row.content || "[Mesaj]",
      lastMessageTime: new Date(row.timestamp * 1000),
      waitingMinutes: Math.floor((now - row.timestamp * 1000) / 60000),
      isGroup: (row.is_group || 0) === 1,
      senderName: row.sender_name || row.chat_jid.split("@")[0] || "Bilinmeyen",
    }));
  }

  /**
   * Bir sohbetin son mesajlarını getir
   */
  getMessages(chatJid: string, limit: number = 20): Message[] {
    if (!this.db) return [];
    const rows = this.db.query<Message, [string, number]>(`
      SELECT id, chat_jid, sender_jid, content, message_type, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(chatJid, limit);

    return rows.reverse();
  }

  /**
   * Mesaj gönder (outbox'a ekle, worker gönderecek)
   */
  sendMessage(toJid: string, content: string): number {
    if (!this.db) throw new Error("WhatsApp kullanılamıyor");
    const result = this.db.run(`
      INSERT INTO outbox (to_jid, message_type, content, status)
      VALUES (?, 'text', ?, 'pending')
    `, [toJid, content]);

    return Number(result.lastInsertRowid);
  }

  /**
   * Resim gönder
   */
  sendImage(toJid: string, filePath: string, caption?: string): number {
    if (!this.db) throw new Error("WhatsApp kullanılamıyor");
    const result = this.db.run(`
      INSERT INTO outbox (to_jid, message_type, content, file_path, caption, status)
      VALUES (?, 'image', '', ?, ?, 'pending')
    `, [toJid, filePath, caption || null]);

    return Number(result.lastInsertRowid);
  }

  /**
   * Kişi ara
   */
  searchContacts(query: string, limit: number = 10): Contact[] {
    if (!this.db) return [];
    return this.db.query<Contact, [string, string, string, number]>(`
      SELECT jid, name, notify, verified_name, phone
      FROM contacts
      WHERE name LIKE ? OR notify LIKE ? OR phone LIKE ?
      LIMIT ?
    `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);
  }

  /**
   * Sohbet ara
   */
  searchChats(query: string, limit: number = 10): Chat[] {
    if (!this.db) return [];
    return this.db.query<Chat, [string, number]>(`
      SELECT jid, name, is_group, unread_count, last_message_timestamp
      FROM chats
      WHERE name LIKE ?
      ORDER BY last_message_timestamp DESC
      LIMIT ?
    `).all(`%${query}%`, limit);
  }

  /**
   * İstatistikler
   */
  getStats(): { contacts: number; chats: number; messages: number } {
    if (!this.db) return { contacts: 0, chats: 0, messages: 0 };

    const contacts = this.db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM contacts"
    ).get()?.count || 0;

    const chats = this.db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM chats"
    ).get()?.count || 0;

    const messages = this.db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM messages"
    ).get()?.count || 0;

    return { contacts, chats, messages };
  }

  /**
   * Worker durumu
   */
  getWorkerStatus(): { connected: boolean; user: string | null } {
    if (!this.db) return { connected: false, user: null };

    const userId = this.db.query<{ value: string }, []>(
      "SELECT value FROM settings WHERE key = 'connected_user_id'"
    ).get()?.value;

    const userName = this.db.query<{ value: string }, []>(
      "SELECT value FROM settings WHERE key = 'connected_user_name'"
    ).get()?.value;

    return {
      connected: !!userId,
      user: userName || null,
    };
  }

  close() {
    if (this.db) this.db.close();
  }
}

export const whatsappDB = new WhatsAppDBService();

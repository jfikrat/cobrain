/**
 * WaMailbox — Per-sender WhatsApp context buffer.
 *
 * Instead of Stem seeing each message in isolation, every sender
 * has a "mailbox" that holds:
 *   - history: last N processed messages (incoming + outgoing)
 *   - pending: new unprocessed messages waiting for triage
 *
 * Stem reads the full mailbox (history + pending) → better decisions.
 */

const HISTORY_LIMIT = 15;

export interface MailboxMessage {
  content: string;
  messageType: string;
  direction: "incoming" | "outgoing";
  timestamp: number;
}

export interface SenderMailbox {
  chatJid: string;
  senderName: string;
  history: MailboxMessage[];
  pending: MailboxMessage[];
}

class WaMailbox {
  private boxes = new Map<string, SenderMailbox>();

  /** Push new incoming messages into a sender's pending queue */
  push(
    chatJid: string,
    senderName: string,
    messages: Array<{ content: string; message_type: string }>,
  ): void {
    if (!this.boxes.has(chatJid)) {
      this.boxes.set(chatJid, { chatJid, senderName, history: [], pending: [] });
    }
    const box = this.boxes.get(chatJid)!;
    box.senderName = senderName;

    for (const msg of messages) {
      box.pending.push({
        content: msg.content,
        messageType: msg.message_type,
        direction: "incoming",
        timestamp: Date.now(),
      });
    }
  }

  /** Record an outgoing reply so future triage has context */
  addOutgoing(chatJid: string, content: string): void {
    const box = this.boxes.get(chatJid);
    if (!box) return;
    box.history.push({
      content,
      messageType: "text",
      direction: "outgoing",
      timestamp: Date.now(),
    });
    this.trimHistory(box);
  }

  /** Get all senders that have pending (unprocessed) messages */
  getPendingChats(): SenderMailbox[] {
    return [...this.boxes.values()].filter((b) => b.pending.length > 0);
  }

  /** After triage: move pending → history, clear pending */
  markProcessed(chatJid: string): void {
    const box = this.boxes.get(chatJid);
    if (!box) return;
    box.history.push(...box.pending);
    box.pending = [];
    this.trimHistory(box);
  }

  /** Get conversation history for a sender */
  getHistory(chatJid: string): MailboxMessage[] {
    return this.boxes.get(chatJid)?.history ?? [];
  }

  /** Get the timestamp of the last outgoing message in history (ms), or 0 if none */
  getLastOutgoingTimestamp(chatJid: string): number {
    const box = this.boxes.get(chatJid);
    if (!box) return 0;
    const outgoing = box.history.filter(m => m.direction === "outgoing");
    if (outgoing.length === 0) return 0;
    return Math.max(...outgoing.map(m => m.timestamp));
  }

  private trimHistory(box: SenderMailbox): void {
    if (box.history.length > HISTORY_LIMIT) {
      box.history = box.history.slice(-HISTORY_LIMIT);
    }
  }
}

export const waMailbox = new WaMailbox();

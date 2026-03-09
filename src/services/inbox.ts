/**
 * Agent Inbox — Cortex's Inbox
 *
 * Pushes BrainLoop/Mneme/Scheduler messages into an inbox.
 * Cortex processes them during BrainLoop fastTick when !isUserBusy.
 * This way the session stays clean while the user is chatting.
 */

import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export interface InboxItem {
  /** "inbox_{timestamp}_{random6hex}" */
  id: string;
  from: "brain-loop" | "mneme" | "scheduler";
  /** Short summary (for logging) */
  subject: string;
  /** Full message (to be sent to Cortex) */
  body: string;
  priority: "urgent" | "normal";
  createdAt: number;
  /** urgent: 30min, normal: 2hr */
  ttlMs: number;
  processedAt?: number;
  /**
   * Wait time before processing (unix ms).
   * Does not appear in pending() if now < processAfter.
   * Used for 60s delay in WA DMs — if the user replies in between, Cobrain skips.
   */
  processAfter?: number;
  /** Which cortex will process (undefined = main Cobrain) */
  cortex?: "wa";
  /** For WA DMs — reply dedup and per-chat guard */
  chatJid?: string;
}

// ── InboxService ──────────────────────────────────────────────────────────

const MAX_PENDING = 30;

class InboxService {
  private items: InboxItem[] = [];
  private loaded = false;
  private dataFile: string | null = null;
  private saving: Promise<void> = Promise.resolve();

  async load(userFolder: string): Promise<void> {
    this.dataFile = join(userFolder, "inbox.json");
    try {
      const file = Bun.file(this.dataFile);
      if (await file.exists()) {
        const data = await file.json();
        this.items = data.items || [];
      }
    } catch (err) {
      console.warn("[Inbox] Failed to load:", err);
      this.items = [];
    }
    this.loaded = true;
    console.log(`[Inbox] Loaded ${this.pending().length} pending items`);
  }

  private async save(): Promise<void> {
    this.saving = this.saving.then(() => this._doSave()).catch(() => {});
    return this.saving;
  }

  private async _doSave(): Promise<void> {
    if (!this.dataFile) return;
    try {
      const tmpPath = `${this.dataFile}.tmp.${Date.now()}`;
      await Bun.write(tmpPath, JSON.stringify({ items: this.items }, null, 2));
      const fs = await import("node:fs/promises");
      await fs.rename(tmpPath, this.dataFile);
    } catch (err) {
      console.warn("[Inbox] Failed to save:", err);
    }
  }

  async push(item: Omit<InboxItem, "id" | "createdAt">): Promise<boolean> {
    // Clean up expired TTL items
    this.cleanExpired();

    const pending = this.pending();

    // If inbox is full, drop the oldest normal item (urgent is preserved)
    if (pending.length >= MAX_PENDING) {
      const oldest = pending
        .filter(i => i.priority === "normal")
        .sort((a, b) => a.createdAt - b.createdAt)[0];

      if (oldest) {
        console.warn(`[Inbox] Full — dropping oldest normal item: "${oldest.subject}"`);
        this.items = this.items.filter(i => i.id !== oldest.id);
      } else {
        // All urgent — reject
        console.warn(`[Inbox] Full (${MAX_PENDING} urgent items). New item rejected: "${item.subject}"`);
        return false;
      }
    }

    const newItem: InboxItem = {
      ...item,
      id: `inbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
    };

    this.items.push(newItem);
    await this.save();

    console.log(`[Inbox] Item added from ${newItem.from} (${newItem.priority}): "${newItem.subject}"`);
    return true;
  }

  /**
   * Unprocessed items — urgent first, then oldest.
   * Does not enter the list if processAfter is set and hasn't been reached yet.
   */
  pending(): InboxItem[] {
    const now = Date.now();
    return this.items
      .filter(i => !i.processedAt && !(i.processAfter && i.processAfter > now))
      .sort((a, b) => {
        if (a.priority === b.priority) return a.createdAt - b.createdAt;
        return a.priority === "urgent" ? -1 : 1;
      });
  }

  /**
   * Is there an unprocessed (no processedAt) item for this chatJid?
   * Includes items waiting for processAfter — used for Guard 2.
   */
  hasChatItem(chatJid: string): boolean {
    return this.items.some(i => !i.processedAt && i.chatJid === chatJid);
  }

  async markProcessed(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (item) {
      item.processedAt = Date.now();
      await this.save();
    }
  }

  cleanExpired(): void {
    const now = Date.now();
    const before = this.items.length;
    this.items = this.items.filter(i => {
      if (i.processedAt) return false; // Processed — clean up
      return now - i.createdAt < i.ttlMs; // TTL not expired
    });
    const removed = before - this.items.length;
    if (removed > 0) {
      console.log(`[Inbox] Cleaned ${removed} expired items`);
      this.save(); // fire-and-forget
    }
  }

  size(): number {
    return this.pending().length;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

export const inbox = new InboxService();

export async function initInbox(userFolder: string): Promise<void> {
  await inbox.load(userFolder);
}

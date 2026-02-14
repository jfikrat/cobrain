/**
 * Reply Dedup — prevents duplicate WhatsApp replies between proactive handler and Cortex pipeline.
 *
 * Contract:
 *  - In-memory only (Map<chatJid, timestamp>). State is lost on process restart.
 *  - 60-second TTL per chatJid. After 60s the entry expires and new replies are allowed.
 *  - Per-process: no cross-process coordination (single Bun instance assumed).
 *  - markReplied() should be called AFTER a successful outbox write to avoid
 *    marking a chat as replied when the send actually failed.
 *  - wasRecentlyReplied() performs lazy cleanup on read (no background timers).
 */

const recentReplies = new Map<string, number>();
const DEDUP_TTL_MS = 60_000; // 60s cooldown per chatJid

/**
 * Mark a chatJid as recently replied. Subsequent calls for the same chatJid
 * reset the TTL (last-write-wins, no duplicate timers).
 */
export function markReplied(chatJid: string): void {
  recentReplies.set(chatJid, Date.now());
}

/**
 * Check whether a chatJid was replied to within the last 60 seconds.
 * Expired entries are lazily deleted on access — no background timers needed.
 */
export function wasRecentlyReplied(chatJid: string): boolean {
  const ts = recentReplies.get(chatJid);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    recentReplies.delete(chatJid);
    return false;
  }
  return true;
}

/**
 * Clear all dedup entries. Intended for testing only.
 */
export function clearAll(): void {
  recentReplies.clear();
}

/** Exported for testing — the TTL constant in milliseconds. */
export const TTL_MS = DEDUP_TTL_MS;

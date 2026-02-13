const recentReplies = new Map<string, number>();
const DEDUP_TTL_MS = 60_000; // 60s cooldown per chatJid

export function markReplied(chatJid: string): void {
  recentReplies.set(chatJid, Date.now());
}

export function wasRecentlyReplied(chatJid: string): boolean {
  const ts = recentReplies.get(chatJid);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    recentReplies.delete(chatJid);
    return false;
  }
  return true;
}

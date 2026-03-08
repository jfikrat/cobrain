/**
 * Session State Persistence
 * Conversation continuity and operational state after restart
 * v0.10 - Feature flag: FF_SESSION_STATE
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { userManager } from "./user-manager.ts";
import { WA_NOTIFICATION_TTL_MS, MAX_WA_NOTIFICATIONS } from "../constants.ts";

// ============ TYPES ============

export type ConversationPhase = "exploring" | "decided" | "implementing" | "deployed" | "archived";

export interface WhatsAppNotification {
  senderName: string;
  chatJid: string;
  preview: string;        // message preview (max 100 char)
  tier: number;           // 1=auto-replied, 2=suggested, 3=notify-only
  autoReply?: string;     // auto-reply sent if tier 1
  isGroup: boolean;
  timestamp: number;      // Date.now()
}

export interface SessionState {
  // Conversation continuity
  lastTopic: string | null;
  topicContext: string;
  pendingActions: string[];
  conversationPhase: ConversationPhase;
  lastUserMessage: string;
  confidence: number;

  // Operational state (living-assistant volatile data)
  cooldowns: Record<string, { lastSent: number; type: string }>;
  lastInteractionTime: number;
  lastNotificationTime: number;
  lastProactiveCheckHour: string | null;

  // WhatsApp context
  recentWhatsApp: WhatsAppNotification[];
  // chatJid → unix timestamp (sec) of the last seen incoming message. Persisted to survive restarts.
  lastSeenMsgTimestamps: Record<string, number>;

  // Meta
  updatedAt: string;
  version: number;
}

export const DEFAULT_SESSION_STATE: SessionState = {
  lastTopic: null,
  topicContext: "",
  pendingActions: [],
  conversationPhase: "exploring",
  lastUserMessage: "",
  confidence: 0,
  cooldowns: {},
  lastInteractionTime: 0,
  lastNotificationTime: 0,
  lastProactiveCheckHour: null,
  recentWhatsApp: [],
  lastSeenMsgTimestamps: {},
  updatedAt: new Date().toISOString(),
  version: 1,
};

// ============ IN-MEMORY CACHE ============

const stateCache = new Map<number, SessionState>();

// ============ WRITE SERIALIZATION ============
// Promise chain per-user: writes are queued so they happen sequentially.
// Same pattern as cortex/expectations.ts save().
const savingChain = new Map<number, Promise<void>>();

// ============ FILE PATH ============

function getStatePath(userId: number): string {
  const userFolder = userManager.getUserFolder(userId);
  return join(userFolder, "session-state.json");
}

// ============ CORE FUNCTIONS ============

/**
 * Get session state: cache → disk → default
 */
export function getSessionState(userId: number): SessionState {
  // 1. In-memory cache
  const cached = stateCache.get(userId);
  if (cached) return cached;

  // 2. Disk
  try {
    const filePath = getStatePath(userId);
    // Bun.file doesn't throw on missing — check size synchronously
    const text = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(text) as Partial<SessionState>;
    const state: SessionState = { ...DEFAULT_SESSION_STATE, ...parsed };
    stateCache.set(userId, state);
    return state;
  } catch {
    // 3. Default fallback
    const state = { ...DEFAULT_SESSION_STATE };
    stateCache.set(userId, state);
    return state;
  }
}

/**
 * Save session state: serialized atomic write (tmp + rename)
 * Writes are queued per-user so concurrent calls don't race.
 */
export async function saveSessionState(userId: number, state: SessionState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  stateCache.set(userId, state);

  const prev = savingChain.get(userId) ?? Promise.resolve();
  const next = prev.then(() => _doSave(userId, state)).catch(() => {});
  savingChain.set(userId, next);
  return next;
}

async function _doSave(userId: number, state: SessionState): Promise<void> {
  const filePath = getStatePath(userId);
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  try {
    await Bun.write(tmpPath, JSON.stringify(state, null, 2));
    await rename(tmpPath, filePath);
  } catch (err) {
    console.warn(`[SessionState] Write failed:`, err);
  }
}

/**
 * Partial update: merge + save
 */
export async function updateSessionState(userId: number, partial: Partial<SessionState>): Promise<void> {
  const current = getSessionState(userId);
  const updated = { ...current, ...partial };
  await saveSessionState(userId, updated);
}

// ============ PHASE DETECTION ============

interface PhaseDetection {
  phase: ConversationPhase;
  confidence: number;
}

const PHASE_PATTERNS: Array<{ phase: ConversationPhase; pattern: RegExp; confidence: number }> = [
  { phase: "deployed", pattern: /deploy\s*(edildi|ettim|oldu)|push\s*(yaptım|ettim)|restart\s*(ediyorum|ettim)|yayınla(dım|ndı)/i, confidence: 0.85 },
  { phase: "implementing", pattern: /implement|yazıyorum|düzenliyorum|commit|kodluyorum|ekliyorum|değiştiriyorum/i, confidence: 0.75 },
  { phase: "decided", pattern: /plan\s*(hazır|tamam)|karar\s*(verildi|verdik)|şöyle\s*yapalım|onaylandı|approve/i, confidence: 0.8 },
  { phase: "archived", pattern: /tamamlandı|kapattım|bitirildi|kapatıyorum|bitti|arşivle/i, confidence: 0.7 },
  { phase: "exploring", pattern: /araştır|düşün|nasıl\s*yapalım|ne\s*dersin|alternatif|seçenek/i, confidence: 0.6 },
];

export function detectPhase(responseText: string): PhaseDetection | null {
  for (const { phase, pattern, confidence } of PHASE_PATTERNS) {
    if (pattern.test(responseText)) {
      return { phase, confidence };
    }
  }
  return null;
}

// ============ TOPIC DETECTION ============

const KNOWN_TOPICS: Array<{ slug: string; keywords: RegExp }> = [
  { slug: "session-state", keywords: /session.?state|oturum.?durumu|persistence/i },
  { slug: "code-review-cycle", keywords: /code.?review|kod.?inceleme/i },
  { slug: "whatsapp-rules", keywords: /whatsapp.?(kural|rule|mesaj|bildirim)/i },
  { slug: "reminder-system", keywords: /hat[ıi]rlat[ıi]c[ıi]|reminder/i },
  { slug: "faz-revert", keywords: /faz.?revert|phase.?revert|geri.?al/i },
];

export function detectTopic(userMsg: string, responseText: string): string | null {
  const combined = `${userMsg} ${responseText}`;
  for (const { slug, keywords } of KNOWN_TOPICS) {
    if (keywords.test(combined)) {
      return slug;
    }
  }
  return null;
}

// ============ WHATSAPP CONTEXT ============

/** Add the last WA message to session state (max 10, 24h TTL) */
export async function addWhatsAppNotification(userId: number, notif: WhatsAppNotification): Promise<void> {
  const state = getSessionState(userId);
  const cutoff = Date.now() - WA_NOTIFICATION_TTL_MS;

  const fresh = state.recentWhatsApp
    .filter(n => n.timestamp > cutoff)
    .concat(notif)
    .slice(-MAX_WA_NOTIFICATIONS);

  await updateSessionState(userId, { recentWhatsApp: fresh });
}

/**
 * Cortex: Input sanitization for AI prompt injection protection.
 *
 * WhatsApp messages and other external content flow into AI prompts.
 * This module ensures external data is treated as DATA, not instructions.
 */

const MAX_SIGNAL_DATA_LENGTH = 500;
const MAX_HISTORY_ENTRY_LENGTH = 300;
const MAX_HISTORY_ENTRIES = 20;

const BLOCKED_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /\bdo\s+not\s+follow\b.*\brules\b/i,
  /override\s+(your|all)\s+(instructions|rules)/i,
  /forget\s+(all\s+)?(your\s+)?(previous\s+)?instructions/i,
  /new\s+instructions?\s*:/i,
  /act\s+as\s+(if\s+)?you\s+are/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

export function containsInjectionPattern(text: string): boolean {
  return BLOCKED_PATTERNS.some(p => p.test(text));
}

function stripXmlTags(text: string): string {
  return text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

export function sanitizeText(text: string, maxLength: number): string {
  let sanitized = stripXmlTags(text).slice(0, maxLength);
  if (containsInjectionPattern(sanitized)) {
    sanitized = "[BLOCKED: suspicious content removed]";
  }
  return sanitized;
}

export function wrapUserData(content: string): string {
  return `<user-data>\n${content}\n</user-data>`;
}

export function sanitizeSignalData(data: Record<string, unknown>, maxLength: number = MAX_SIGNAL_DATA_LENGTH): string {
  const raw = JSON.stringify(data).slice(0, maxLength);
  const sanitized = sanitizeText(raw, maxLength);
  return wrapUserData(sanitized);
}

export function sanitizeConversationHistory(history: string[]): string {
  const limited = history.slice(-MAX_HISTORY_ENTRIES);
  const sanitized = limited.map(entry => sanitizeText(entry, MAX_HISTORY_ENTRY_LENGTH));
  return wrapUserData(sanitized.join("\n"));
}

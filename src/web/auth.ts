/**
 * Web UI Authentication
 * Token-based session management for web clients
 */

interface TokenData {
  userId: number;
  createdAt: number;
  expiresAt: number;
}

// Token storage - in production consider Redis/DB
const tokens = new Map<string, TokenData>();

// Token expiry: 24 hours
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Cleanup interval: 1 hour
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Generate a new session token for a user
 */
export function generateSessionToken(userId: number): string {
  const token = crypto.randomUUID();
  const now = Date.now();

  tokens.set(token, {
    userId,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  });

  console.log(`[Web Auth] Token generated for user ${userId}: ${token.slice(0, 8)}...`);
  return token;
}

/**
 * Validate a token and return user ID if valid
 */
export function validateToken(token: string): number | null {
  const data = tokens.get(token);

  if (!data) {
    return null;
  }

  // Check expiry
  if (Date.now() > data.expiresAt) {
    tokens.delete(token);
    console.log(`[Web Auth] Token expired: ${token.slice(0, 8)}...`);
    return null;
  }

  return data.userId;
}

/**
 * Revoke a token
 */
export function revokeToken(token: string): boolean {
  const existed = tokens.has(token);
  tokens.delete(token);
  if (existed) {
    console.log(`[Web Auth] Token revoked: ${token.slice(0, 8)}...`);
  }
  return existed;
}

/**
 * Get token info without validation
 */
export function getTokenInfo(token: string): TokenData | null {
  return tokens.get(token) || null;
}

/**
 * Clean up expired tokens
 */
function cleanupExpiredTokens(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [token, data] of tokens.entries()) {
    if (now > data.expiresAt) {
      tokens.delete(token);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[Web Auth] Cleaned up ${cleaned} expired tokens`);
  }
}

// Start periodic cleanup
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenCleanup(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(cleanupExpiredTokens, CLEANUP_INTERVAL_MS);
  console.log("[Web Auth] Token cleanup started");
}

export function stopTokenCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log("[Web Auth] Token cleanup stopped");
  }
}

/**
 * Get auth stats
 */
export function getAuthStats(): { activeTokens: number } {
  return {
    activeTokens: tokens.size,
  };
}

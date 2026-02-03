/**
 * Memory-related type definitions for Cobrain v0.2
 * Vector memory with sqlite-vec
 */

export type MemoryType = "episodic" | "semantic" | "procedural";

export interface MemoryEntry {
  id: number;
  vectorRowid: number;
  type: MemoryType;
  content: string;
  summary?: string;
  importance: number; // 0.0 - 1.0
  accessCount: number;
  lastAccessedAt?: string;
  source?: string; // "conversation", "manual", "extracted"
  sourceRef?: string; // message ID, session ID, etc.
  metadata: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
}

export interface MemoryInput {
  type: MemoryType;
  content: string;
  summary?: string;
  importance?: number;
  source?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
}

export interface MemoryQuery {
  /** Search query text (will be embedded) */
  query: string;

  /** Filter by memory type */
  type?: MemoryType;

  /** Minimum similarity score (0.0 - 1.0) */
  minSimilarity?: number;

  /** Maximum results to return */
  limit?: number;

  /** Include expired memories */
  includeExpired?: boolean;
}

export interface MemorySearchResult extends MemoryEntry {
  /** Cosine similarity score (0.0 - 1.0) */
  similarity: number;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  avgImportance: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}

/** Default retention periods by memory type (in days) */
export const MEMORY_RETENTION: Record<MemoryType, number | null> = {
  episodic: 90, // 90 days
  semantic: null, // permanent
  procedural: null, // permanent
};

/**
 * Memory Consolidation Service
 * Weekly batch consolidation: promote, dedup, conflict resolve, rebalance
 * Inspired by sleep consolidation in the human brain
 * Cobrain v0.9
 */

import { SmartMemory } from "../memory/smart-memory.ts";
import { userManager } from "./user-manager.ts";
import {
  isHaikuAvailable,
  classifyForPromotion,
  findDuplicates,
  resolveConflict,
} from "./haiku.ts";
import type { MemoryEntry } from "../types/memory.ts";

export interface ConsolidationResult {
  promoted: number;
  merged: number;
  conflictsResolved: number;
  rebalanced: { up: number; down: number };
  errors: string[];
  durationMs: number;
}

/**
 * Run full memory consolidation for a user
 * Each phase is independent — if one fails, others continue
 */
export async function consolidateMemories(userId: number): Promise<ConsolidationResult> {
  const start = Date.now();
  const result: ConsolidationResult = {
    promoted: 0,
    merged: 0,
    conflictsResolved: 0,
    rebalanced: { up: 0, down: 0 },
    errors: [],
    durationMs: 0,
  };

  const userFolder = userManager.getUserFolder(userId);
  const memory = new SmartMemory(userFolder, userId);

  try {
    // Phase 1: Promote important episodics to semantic
    try {
      result.promoted = await promoteEpisodics(memory);
      console.log(`[Consolidation] Phase 1 done: ${result.promoted} promoted`);
    } catch (error) {
      const msg = `Phase 1 (promote) failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[Consolidation] ${msg}`);
      result.errors.push(msg);
    }

    // Phase 2: Merge duplicate memories
    try {
      result.merged = await mergeDuplicates(memory);
      console.log(`[Consolidation] Phase 2 done: ${result.merged} merged`);
    } catch (error) {
      const msg = `Phase 2 (dedup) failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[Consolidation] ${msg}`);
      result.errors.push(msg);
    }

    // Phase 3: Resolve conflicting memories
    try {
      result.conflictsResolved = await resolveConflicts(memory);
      console.log(`[Consolidation] Phase 3 done: ${result.conflictsResolved} conflicts resolved`);
    } catch (error) {
      const msg = `Phase 3 (conflict) failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[Consolidation] ${msg}`);
      result.errors.push(msg);
    }

    // Phase 4: Rebalance importance scores (pure SQL, no AI)
    try {
      result.rebalanced = rebalanceImportance(memory);
      console.log(`[Consolidation] Phase 4 done: ${result.rebalanced.up} up, ${result.rebalanced.down} down`);
    } catch (error) {
      const msg = `Phase 4 (rebalance) failed: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[Consolidation] ${msg}`);
      result.errors.push(msg);
    }
  } finally {
    memory.close();
  }

  result.durationMs = Date.now() - start;
  console.log(
    `[Consolidation] Complete for user ${userId} in ${result.durationMs}ms: ` +
    `promoted=${result.promoted} merged=${result.merged} conflicts=${result.conflictsResolved} ` +
    `rebalance=${result.rebalanced.up}↑/${result.rebalanced.down}↓ errors=${result.errors.length}`
  );

  return result;
}

/**
 * Phase 1: Promote frequently-accessed, important episodic memories to semantic
 */
async function promoteEpisodics(memory: SmartMemory): Promise<number> {
  if (!isHaikuAvailable()) {
    console.log("[Consolidation] Haiku unavailable, skipping promotion");
    return 0;
  }

  const candidates = memory.getPromotionCandidates(3, 0.7, 90);
  if (candidates.length === 0) return 0;

  console.log(`[Consolidation] Phase 1: ${candidates.length} promotion candidates`);

  const classifications = await classifyForPromotion(
    candidates.map((c) => ({ id: c.id, content: c.content, summary: c.summary }))
  );

  let promoted = 0;
  for (const cls of classifications) {
    if (cls.promote) {
      const ok = memory.promoteToSemantic(cls.id);
      if (ok) {
        promoted++;
        console.log(`[Consolidation] Promoted #${cls.id}: ${cls.reason}`);
      }
    }
  }

  return promoted;
}

/**
 * Phase 2: Find and merge duplicate memories
 */
async function mergeDuplicates(memory: SmartMemory): Promise<number> {
  if (!isHaikuAvailable()) {
    console.log("[Consolidation] Haiku unavailable, skipping dedup");
    return 0;
  }

  const recent = memory.getRecentByTags(30, 100);
  if (recent.length < 2) return 0;

  console.log(`[Consolidation] Phase 2: checking ${recent.length} memories for duplicates`);

  // Process in batches of 20 to stay within token limits
  let totalMerged = 0;
  const mergedInRun = new Set<number>();

  for (let i = 0; i < recent.length; i += 20) {
    const batch = recent.slice(i, i + 20).filter((m) => !mergedInRun.has(m.id));
    if (batch.length < 2) continue;

    const groups = await findDuplicates(
      batch.map((m) => ({
        id: m.id,
        content: m.content,
        summary: m.summary,
        tags: m.tags || "",
      }))
    );

    for (const group of groups) {
      // Validate keepId is actually in the group
      if (!group.ids.includes(group.keepId)) {
        console.warn(`[Consolidation] Invalid keepId #${group.keepId} not in group [${group.ids}], skipping`);
        continue;
      }
      // Skip IDs already merged in this run
      const sourceIds = group.ids.filter((id) => id !== group.keepId && !mergedInRun.has(id));
      if (sourceIds.length > 0) {
        const ok = memory.mergeMemories(sourceIds, group.keepId);
        if (ok) {
          for (const id of sourceIds) mergedInRun.add(id);
          totalMerged += sourceIds.length;
          console.log(`[Consolidation] Merged ${sourceIds.join(",")} → #${group.keepId}`);
        } else {
          console.warn(`[Consolidation] Merge failed for target #${group.keepId}, skipping`);
        }
      }
    }
  }

  return totalMerged;
}

/**
 * Phase 3: Resolve conflicting memories (same tags, different content)
 */
async function resolveConflicts(memory: SmartMemory): Promise<number> {
  if (!isHaikuAvailable()) {
    console.log("[Consolidation] Haiku unavailable, skipping conflict resolution");
    return 0;
  }

  const candidates = memory.getConflictCandidates(90);
  if (candidates.length < 2) return 0;

  console.log(`[Consolidation] Phase 3: checking ${candidates.length} memories for conflicts`);

  // Group by overlapping tags
  const tagGroups = groupByOverlappingTags(candidates);
  let resolved = 0;
  const softDeletedInRun = new Set<number>();

  for (const group of tagGroups) {
    if (group.length < 2) continue;

    // Pairwise comparison within group
    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const mem1 = group[i]!;
        const mem2 = group[j]!;

        // Skip if already soft-deleted (from DB or this run)
        if (mem1.metadata?.softDeleted || mem2.metadata?.softDeleted) continue;
        if (softDeletedInRun.has(mem1.id) || softDeletedInRun.has(mem2.id)) continue;

        // Only resolve if content actually conflicts (not just different)
        if (mem1.content === mem2.content) continue;

        const resolution = await resolveConflict(
          { id: mem1.id, content: mem1.content, createdAt: mem1.createdAt },
          { id: mem2.id, content: mem2.content, createdAt: mem2.createdAt }
        );

        const deleted = memory.softDelete(resolution.removeId, `conflict: ${resolution.reason}`, resolution.keepId);
        if (deleted) {
          softDeletedInRun.add(resolution.removeId);
          resolved++;
          console.log(`[Consolidation] Conflict resolved: keep #${resolution.keepId}, remove #${resolution.removeId}: ${resolution.reason}`);
        } else {
          console.warn(`[Consolidation] Conflict soft-delete failed for #${resolution.removeId}`);
        }
      }
    }
  }

  return resolved;
}

/**
 * Phase 4: Rebalance importance scores based on access patterns (pure SQL, no AI)
 */
function rebalanceImportance(memory: SmartMemory): { up: number; down: number } {
  const { upCandidates, downCandidates } = memory.getRebalanceCandidates();

  let up = 0;
  let down = 0;

  // Boost frequently accessed memories
  for (const candidate of upCandidates) {
    const newImportance = Math.min(1.0, candidate.importance + 0.1);
    if (memory.updateImportance(candidate.id, newImportance)) {
      up++;
    }
  }

  // Decay unused old memories
  for (const candidate of downCandidates) {
    const newImportance = Math.max(0.1, candidate.importance - 0.1);
    if (memory.updateImportance(candidate.id, newImportance)) {
      down++;
    }
  }

  return { up, down };
}

/**
 * Group memories by overlapping tags (at least 50% tag overlap)
 */
function groupByOverlappingTags(memories: MemoryEntry[]): MemoryEntry[][] {
  const groups: MemoryEntry[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < memories.length; i++) {
    if (assigned.has(i)) continue;

    const mem = memories[i]!;
    const memTags = new Set((mem.tags || "").split(",").filter(Boolean));
    if (memTags.size === 0) continue;

    const group = [mem];
    assigned.add(i);

    for (let j = i + 1; j < memories.length; j++) {
      if (assigned.has(j)) continue;

      const other = memories[j]!;
      const otherTags = new Set((other.tags || "").split(",").filter(Boolean));
      if (otherTags.size === 0) continue;

      // Check overlap >= 50%
      const intersection = [...memTags].filter((t) => otherTags.has(t));
      const minSize = Math.min(memTags.size, otherTags.size);
      if (minSize > 0 && intersection.length / minSize >= 0.5) {
        group.push(other);
        assigned.add(j);
      }
    }

    if (group.length >= 2) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Hub Agent Context Builder
 * Builds hub agent awareness context for main Cobrain's system prompt.
 * 5-minute TTL in-memory cache.
 */

import type { DynamicContext } from "../agent/prompts.ts";
import { listActiveAgents } from "./registry.ts";
import { getAgentHistory } from "./interaction-log.ts";
import { DAY_MS } from "../constants.ts";

type HubAgentsContext = NonNullable<DynamicContext["hubAgents"]>;

// ========== Cache ==========

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache: { data: HubAgentsContext; expiresAt: number } | null = null;

export function invalidateHubContextCache(): void {
  _cache = null;
}

// ========== Helpers ==========

export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dk önce`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} saat önce`;

  const days = Math.floor(hours / 24);
  return `${days} gün önce`;
}

// ========== Main Builder ==========

export async function buildHubAgentContext(
  userFolder: string,
): Promise<HubAgentsContext | undefined> {
  // Return cached if fresh
  if (_cache && Date.now() < _cache.expiresAt) {
    return _cache.data;
  }

  const activeAgents = listActiveAgents();
  if (activeAgents.length === 0) return undefined;

  const now = Date.now();

  const agents: HubAgentsContext["agents"] = activeAgents.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    lastActiveAgo: a.lastActiveAt ? formatRelativeTime(a.lastActiveAt) : undefined,
  }));

  // Fetch recent activity for agents active in the last 24h
  const recentActivity: NonNullable<HubAgentsContext["recentActivity"]> = [];

  for (const agent of activeAgents) {
    if (!agent.lastActiveAt) continue;
    const age = now - new Date(agent.lastActiveAt).getTime();
    if (age > DAY_MS) continue;

    try {
      const history = await getAgentHistory(userFolder, agent.id, 1);
      const last = history[0];
      if (last) {
        const minutesAgo = Math.round((now - new Date(last.timestamp).getTime()) / 60000);
        const summary = `Soru: ${last.userMessage.slice(0, 60)} → Cevap: ${last.agentResponse.slice(0, 80)}`;
        recentActivity.push({ agentId: agent.id, summary, minutesAgo });
      }
    } catch (e) {
      console.warn("[HubContext] Agent history fetch failed:", e);
    }
  }

  const data: HubAgentsContext = {
    agents,
    recentActivity: recentActivity.length > 0 ? recentActivity : undefined,
  };

  // Cache it
  _cache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}

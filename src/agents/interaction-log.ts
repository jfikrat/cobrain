/**
 * Agent Interaction Log
 * Append-only JSONL logger for cross-agent visibility
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface AgentInteraction {
  timestamp: string;
  agentId: string;
  userMessage: string;
  agentResponse: string;
  channel: string;
  toolsUsed?: string[];
  costUsd?: number;
}

function historyPath(userFolder: string, agentId: string): string {
  return join(userFolder, "agents", agentId, "history.jsonl");
}

/**
 * Append an interaction to the agent's JSONL history file.
 */
export async function logAgentInteraction(
  userFolder: string,
  interaction: AgentInteraction,
): Promise<void> {
  const dir = join(userFolder, "agents", interaction.agentId);
  await mkdir(dir, { recursive: true });

  const path = historyPath(userFolder, interaction.agentId);
  const line = JSON.stringify(interaction) + "\n";

  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(path, existing + line);
}

/**
 * Read the last N interactions for an agent.
 */
export async function getAgentHistory(
  userFolder: string,
  agentId: string,
  limit = 10,
): Promise<AgentInteraction[]> {
  const path = historyPath(userFolder, agentId);

  try {
    const text = await Bun.file(path).text();
    const lines = text.trim().split("\n").filter(Boolean);
    const recent = lines.slice(-limit);
    return recent.map((line) => JSON.parse(line) as AgentInteraction);
  } catch {
    return [];
  }
}

/**
 * Get a human-readable summary of recent agent interactions.
 */
export async function getAgentHistorySummary(
  userFolder: string,
  agentId: string,
  limit = 5,
): Promise<string> {
  const history = await getAgentHistory(userFolder, agentId, limit);

  if (history.length === 0) {
    return `No interactions recorded for agent "${agentId}".`;
  }

  const lines = history.map((h) => {
    const time = new Date(h.timestamp).toLocaleString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
    const tools = h.toolsUsed?.length ? ` [tools: ${h.toolsUsed.join(", ")}]` : "";
    const cost = h.costUsd ? ` ($${h.costUsd.toFixed(4)})` : "";
    return `[${time}] Q: ${h.userMessage.slice(0, 80)}...\nA: ${h.agentResponse.slice(0, 120)}...${tools}${cost}`;
  });

  return `Last ${history.length} interactions (${agentId}):\n\n${lines.join("\n\n")}`;
}

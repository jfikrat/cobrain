/**
 * Cobrain System Prompts
 * Agent SDK system prompt management
 * v0.6 - Fully md-based (zero hardcoded prompt content)
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";

/** Directory containing default mind files shipped with the repo */
const MIND_DEFAULTS_DIR = join(import.meta.dir, "..", "mind-defaults");

/**
 * Dynamic context injected into system prompt per conversation
 */
export interface DynamicContext {
  time: {
    now: string;        // "08 February 2026, Sunday, 02:30"
    dayPart: string;    // "night" | "morning" | "afternoon" | "evening"
    isWeekend: boolean;
  };
  recentMemories?: string[];  // Last 5 memory entries
  hubAgents?: {
    agents: Array<{
      id: string;
      name: string;
      type: string;
      lastActiveAgo?: string;
    }>;
    recentActivity?: Array<{
      agentId: string;
      summary: string;
      minutesAgo: number;
    }>;
  };
  sessionState?: {
    lastTopic: string | null;
    topicContext: string;
    pendingActions: string[];
    conversationPhase: string;
    lastUserMessage: string;
  };
  channel?: string; // "telegram" | "api" | "wa" etc.
}

/**
 * Build dynamic context XML (time, recent memories, session state)
 *
 * Token budget targets (enforced in chat.ts before injection):
 * - recentMemories: max 5 entries, each <=200 chars, deduplicated
 * - sessionState.lastUserMessage: <=500 chars (truncated in chat.ts)
 * Total dynamic context target: ~600-1000 tokens
 */
function buildDynamicContextXml(ctx: DynamicContext): string {
  let xml = `<dynamic-context>
  <time now="${escapeXml(ctx.time.now)}" dayPart="${escapeXml(ctx.time.dayPart)}" isWeekend="${ctx.time.isWeekend}"/>`;

  if (ctx.channel) {
    xml += `\n  <channel>${escapeXml(ctx.channel)}</channel>`;
  }

  if (ctx.recentMemories && ctx.recentMemories.length > 0) {
    xml += `\n  <recent-memories>`;
    for (const mem of ctx.recentMemories) {
      xml += `\n    <memory>${escapeXml(mem)}</memory>`;
    }
    xml += `\n  </recent-memories>`;
  }

  if (ctx.sessionState && ctx.sessionState.lastTopic) {
    xml += `\n  <session-continuity>`;
    xml += `\n    <last-topic>${escapeXml(ctx.sessionState.lastTopic)}</last-topic>`;
    xml += `\n    <phase>${escapeXml(ctx.sessionState.conversationPhase)}</phase>`;
    if (ctx.sessionState.lastUserMessage) {
      xml += `\n    <last-user-message>${escapeXml(ctx.sessionState.lastUserMessage)}</last-user-message>`;
    }
    if (ctx.sessionState.pendingActions.length > 0) {
      xml += `\n    <pending-actions>`;
      for (const action of ctx.sessionState.pendingActions) {
        xml += `\n      <action>${escapeXml(action)}</action>`;
      }
      xml += `\n    </pending-actions>`;
    }
    xml += `\n  </session-continuity>`;
  }

  if (ctx.hubAgents && ctx.hubAgents.agents.length > 0) {
    xml += `\n  <hub-agents hint="To interact with agents: agent_delegate (send message), agent_get_history (read history). Use these tools for source code search.">`;
    for (const agent of ctx.hubAgents.agents) {
      const lastActive = agent.lastActiveAgo ? ` lastActive="${escapeXml(agent.lastActiveAgo)}"` : "";
      xml += `\n    <agent id="${escapeXml(agent.id)}" name="${escapeXml(agent.name)}" type="${escapeXml(agent.type)}"${lastActive}/>`;
    }
    if (ctx.hubAgents.recentActivity && ctx.hubAgents.recentActivity.length > 0) {
      xml += `\n    <recent-activity>`;
      for (const act of ctx.hubAgents.recentActivity) {
        xml += `\n      <interaction agent="${escapeXml(act.agentId)}" minutes-ago="${act.minutesAgo}">${escapeXml(act.summary)}</interaction>`;
      }
      xml += `\n    </recent-activity>`;
    }
    xml += `\n  </hub-agents>`;
  }

  xml += `\n</dynamic-context>`;
  return xml;
}

// ========== Helper Functions ==========

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ========== MD-based System Prompt ==========

/** Ordered list of mind files to read. New files are also added to defaults. */
const MIND_FILES = [
  "identity.md",
  "capabilities.md",
  "rules.md",
  "inbox.md",
  "memory.md",
  "behaviors.md",
  "responses.md",
  "user.md",
  "contacts.md",
];

/**
 * Scaffold mind/ directory for a user — copies missing default files.
 * Safe to call multiple times (idempotent). Never overwrites existing files.
 */
export async function scaffoldMindFiles(userFolder: string): Promise<void> {
  const mindDir = join(userFolder, "mind");
  await mkdir(mindDir, { recursive: true });

  for (const file of MIND_FILES) {
    const target = join(mindDir, file);
    const exists = await Bun.file(target).exists();
    if (!exists) {
      try {
        const defaultContent = await Bun.file(join(MIND_DEFAULTS_DIR, file)).text();
        await Bun.write(target, defaultContent);
      } catch { /* default file doesn't exist — skip */ }
    }
  }
}

/**
 * Read mind/*.md files from the user's folder and concatenate them.
 * Files that don't exist are silently skipped.
 */
export async function readMindFiles(userFolder: string): Promise<string> {
  const mindDir = join(userFolder, "mind");
  const sections: string[] = [];

  for (const file of MIND_FILES) {
    try {
      const content = await Bun.file(join(mindDir, file)).text();
      if (content.trim()) sections.push(content.trim());
    } catch { /* file doesn't exist — skip */ }
  }

  if (sections.length === 0) {
    return `# Assistant\nYou are a personal AI assistant.`;
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build system prompt from mind/*.md content + optional dynamic context.
 * Zero hardcoded prompt content — everything comes from mind files.
 */
export function buildMdSystemPrompt(mindContent: string, dynamicContext?: DynamicContext): string {
  const dynamic = dynamicContext ? '\n\n' + buildDynamicContextXml(dynamicContext) : '';
  return `${mindContent}${dynamic}`;
}

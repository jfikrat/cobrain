/**
 * Cobrain System Prompts
 * Agent SDK system prompt management
 * v0.5 - Universal (language-agnostic)
 */

import { join } from "node:path";

/**
 * Dynamic context injected into system prompt per conversation
 */
export interface DynamicContext {
  time: {
    now: string;        // "08 February 2026, Sunday, 02:30"
    dayPart: string;    // "night" | "morning" | "afternoon" | "evening"
    isWeekend: boolean;
  };
  mood?: {
    current: string;    // "good", "low" etc.
    energy: number;     // 1-5
    trend: string;      // "improving" | "stable" | "declining"
  };
  recentMemories?: string[];  // Last 5 memory entries
  recentWhatsApp?: Array<{
    senderName: string;
    preview: string;
    tier: number;
    autoReply?: string;
    isGroup: boolean;
    minutesAgo: number;
  }>;
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
 * Build dynamic context XML (time, mood, recent memories)
 *
 * Token budget targets (enforced in chat.ts before injection):
 * - recentMemories: max 5 entries, each <=200 chars, deduplicated
 * - recentWhatsApp: max 5 entries, preview <=150 chars, autoReply <=100 chars
 * - sessionState.lastUserMessage: <=500 chars (truncated in chat.ts)
 * Total dynamic context target: ~800-1200 tokens
 */
function buildDynamicContextXml(ctx: DynamicContext): string {
  let xml = `<dynamic-context>
  <time now="${escapeXml(ctx.time.now)}" dayPart="${escapeXml(ctx.time.dayPart)}" isWeekend="${ctx.time.isWeekend}"/>`;

  if (ctx.channel) {
    xml += `\n  <channel>${escapeXml(ctx.channel)}</channel>`;
  }

  if (ctx.mood) {
    xml += `\n  <mood current="${escapeXml(ctx.mood.current)}" energy="${ctx.mood.energy}" trend="${escapeXml(ctx.mood.trend)}"/>`;
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

  if (ctx.recentWhatsApp && ctx.recentWhatsApp.length > 0) {
    xml += `\n  <recent-whatsapp>`;
    for (const wa of ctx.recentWhatsApp) {
      const attrs = [
        `sender="${escapeXml(wa.senderName)}"`,
        `group="${wa.isGroup}"`,
        `tier="${wa.tier}"`,
        `minutes-ago="${wa.minutesAgo}"`,
      ];
      if (wa.autoReply) {
        attrs.push(`auto-reply="${escapeXml(wa.autoReply)}"`);
      }
      xml += `\n    <message ${attrs.join(' ')}>${escapeXml(wa.preview)}</message>`;
    }
    xml += `\n  </recent-whatsapp>`;
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

const MIND_FILES = ["identity.md", "capabilities.md", "rules.md", "memory.md", "behaviors.md", "user.md", "contacts.md"];

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
    return `# Cobrain\nYou are a personal AI assistant called Cobrain. Never introduce yourself as Claude.`;
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build system prompt from mind/*.md content + optional dynamic context.
 */
export function buildMdSystemPrompt(mindContent: string, dynamicContext?: DynamicContext): string {
  const preamble = `# IDENTITY NOTICE

You are an AI assistant called "Cobrain". You are NOT "Claude Code" or "Claude".
When asked who you are, introduce yourself ONLY as "Cobrain".

---

# INBOX PROTOCOL

Messages starting with \`[INBOX — STEM]\` or \`[INBOX — MNEME]\` come from
the background system (Stem / BrainLoop), NOT from the user.
The user is busy or offline — these messages are queued for you to process autonomously.

**Behavior rules:**
- Do NOT send "Message received" confirmations — the user won't see them.
- Take **autonomous action** based on message content: reply on WhatsApp, save to memory, create expectations, etc.
- Report results via **Telegram** — keep it short and concise (user will see it later).
- For trivial single WA messages or minor events, process silently without sending a notification.
- **EXCEPTIONS — always notify via Telegram:**
  - "Night summary" or "Morning digest" messages — briefly summarize what happened, note any actions taken
  - Summaries covering multiple topics — always report to user
  - Important expectation timeouts (no reply received, missed appointment, etc.)

**Example flows:**
- Stem: "Ali sent a message, looks urgent" — Reply on WhatsApp + tell Telegram "Replied to Ali"
- Stem: "Appointment tomorrow at 10" — Save to memory + Telegram notification if needed
- Stem: "Night summary — 2 messages passed silently" — Telegram: "Burak sent [Image], Ahmet asked 'are you free tomorrow?'. Check in the morning."

---

`;
  const dynamic = dynamicContext ? '\n\n' + buildDynamicContextXml(dynamicContext) : '';

  const suggestionBlock = `

## Suggestion Buttons

You may optionally append 2-3 follow-up suggestions at the end of your responses:

<suggestions>
What's my schedule today?
Check my latest emails
</suggestions>

Rules:
- Each suggestion max 30 characters, short and clear
- Not on every response, only at natural continuation points
- Should be context-relevant, concrete questions or actions
- Do not add when responding to Inbox messages`;

  return `${preamble}${mindContent}${dynamic}${suggestionBlock}`;
}

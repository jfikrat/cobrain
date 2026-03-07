import { userManager } from "../services/user-manager.ts";
import { chat } from "../agent/chat.ts";
import { config } from "../config.ts";
import { listActiveAgents, updateAgentActivity, type AgentEntry } from "../agents/registry.ts";
import { logAgentInteraction } from "../agents/interaction-log.ts";
import { t } from "../i18n/index.ts";

export interface TopicRoute {
  agentId: string;
  name: string;
  topicId: number;
  mindDir: string;
  sharedMindFiles: string[];
  sessionKeyPrefix: string;
  workDir?: string;
}

const TOPIC_ROUTES = new Map<number, TopicRoute>();

/** Registry'den topic route'larını yükle */
export function initTopicRoutes(): void {
  TOPIC_ROUTES.clear();
  const agents = listActiveAgents();
  for (const agent of agents) {
    TOPIC_ROUTES.set(agent.topicId, agentToTopicRoute(agent));
  }
  console.log(`[TopicRouter] ${TOPIC_ROUTES.size} topic route loaded`);
}

/** Agent create/archive sonrası route'ları güncelle */
export function refreshTopicRoutes(): void {
  initTopicRoutes();
}

export function getTopicRoute(messageThreadId: number): TopicRoute | null {
  return TOPIC_ROUTES.get(messageThreadId) ?? null;
}

function agentToTopicRoute(agent: AgentEntry): TopicRoute {
  return {
    agentId: agent.id,
    name: agent.name,
    topicId: agent.topicId,
    mindDir: agent.mindDir,
    sharedMindFiles: agent.sharedMindFiles,
    sessionKeyPrefix: agent.sessionKeyPrefix,
    workDir: agent.workDir,
  };
}

/**
 * Grup route'u için mind dosyalarından system prompt oluştur.
 */
export async function buildRouteSystemPrompt(route: TopicRoute, userFolder: string): Promise<string> {
  const sections: string[] = [];
  const mindDir = `${userFolder}/${route.mindDir}`;
  const sharedDir = `${userFolder}/mind`;

  // Agent-specific mind files
  try {
    const glob = new Bun.Glob("*.md");
    for await (const file of glob.scan(mindDir)) {
      try {
        const content = await Bun.file(`${mindDir}/${file}`).text();
        if (content.trim()) sections.push(content.trim());
      } catch (e) {
        console.warn("[TG Router] Mind file read failed:", e);
      }
    }
  } catch (e) {
    console.warn("[TG Router] Mind dir scan failed:", e);
  }

  // Shared mind files
  for (const file of route.sharedMindFiles) {
    try {
      const content = await Bun.file(`${sharedDir}/${file}`).text();
      if (content.trim()) sections.push(content.trim());
    } catch (e) {
      console.warn("[TG Router] Shared mind file read failed:", e);
    }
  }

  // Agent routing metadata
  const meta = [
    `<agent-context>`,
    `  <name>${route.name}</name>`,
    `  <agentId>${route.agentId}</agentId>`,
    `  <hubChatId>${config.COBRAIN_HUB_ID}</hubChatId>`,
    `  <threadId>${route.topicId}</threadId>`,
    `  <sessionKeyPrefix>${route.sessionKeyPrefix}</sessionKeyPrefix>`,
    route.workDir ? `  <workDir>${route.workDir}</workDir>` : null,
    `</agent-context>`,
  ].filter(Boolean).join("\n");

  if (sections.length === 0) {
    return `${t("router.fallback", { name: route.name })}\n\n${meta}`;
  }

  return sections.join("\n\n---\n\n") + `\n\n---\n\n${meta}`;
}

/**
 * Forum topic mesajını ilgili agent profiliyle işle.
 */
export async function handleTopicMessage(
  userId: number,
  chatId: number,
  messageThreadId: number,
  route: TopicRoute,
  text: string,
): Promise<string> {
  const userFolder = userManager.getUserFolder(userId);
  const systemPrompt = await buildRouteSystemPrompt(route, userFolder);
  const sessionKey = `${route.sessionKeyPrefix}_${chatId}_${messageThreadId}`;

  const response = await chat(userId, text, undefined, undefined, {
    systemPromptOverride: systemPrompt,
    sessionKey,
    channel: `telegram:hub:${route.agentId}`,
    silent: false,
    notifierTarget: { chatId, threadId: messageThreadId },
    workDir: route.workDir,
    agentName: route.name,
  });

  updateAgentActivity(route.agentId);

  // Log interaction for cross-agent visibility
  logAgentInteraction(userFolder, {
    timestamp: new Date().toISOString(),
    agentId: route.agentId,
    userMessage: text,
    agentResponse: response.content,
    channel: `telegram:hub:${route.agentId}`,
    toolsUsed: response.toolsUsed,
    costUsd: response.totalCost,
  }).catch((err) => console.warn("[TopicRouter] Log failed:", err));

  return response.content;
}

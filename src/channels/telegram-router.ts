import { userManager } from "../services/user-manager.ts";
import { chat } from "../agent/chat.ts";
import { config } from "../config.ts";
import { getAgentByTopicId, listActiveAgents, updateAgentActivity, type AgentEntry } from "../agents/registry.ts";
import { logAgentInteraction } from "../agents/interaction-log.ts";

interface GroupRoute {
  name: string;
  /** USER_FOLDER'a göre relative path: "agents/wa/mind" */
  mindDir: string;
  /** USER_FOLDER/mind/ altındaki paylaşılan dosyalar */
  sharedMindFiles: string[];
  /** Session key prefix: "tg_wa" → "tg_wa_<chatId>" */
  sessionKeyPrefix: string;
}

export interface TopicRoute {
  agentId: string;
  name: string;
  mindDir: string;
  sharedMindFiles: string[];
  sessionKeyPrefix: string;
}

const GROUP_ROUTES = new Map<number, GroupRoute>();
const TOPIC_ROUTES = new Map<number, TopicRoute>();

export function initGroupRoutes(): void {
  // WA Agent chat grubu — kullanıcı burada WA agent persona'sıyla konuşur
  if (config.WA_AGENT_CHAT_ID) {
    GROUP_ROUTES.set(config.WA_AGENT_CHAT_ID, {
      name: "wa-agent",
      mindDir: "agents/wa/mind",
      sharedMindFiles: ["contacts.md"],
      sessionKeyPrefix: "tg_wa",
    });
  }
}

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

export function getGroupRoute(chatId: number): GroupRoute | null {
  return GROUP_ROUTES.get(chatId) ?? null;
}

function agentToTopicRoute(agent: AgentEntry): TopicRoute {
  return {
    agentId: agent.id,
    name: agent.name,
    mindDir: agent.mindDir,
    sharedMindFiles: agent.sharedMindFiles,
    sessionKeyPrefix: agent.sessionKeyPrefix,
  };
}

/**
 * Grup route'u için mind dosyalarından system prompt oluştur.
 */
export async function buildRouteSystemPrompt(route: GroupRoute | TopicRoute, userFolder: string): Promise<string> {
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
      } catch {}
    }
  } catch {}

  // Shared mind files
  for (const file of route.sharedMindFiles) {
    try {
      const content = await Bun.file(`${sharedDir}/${file}`).text();
      if (content.trim()) sections.push(content.trim());
    } catch {}
  }

  if (sections.length === 0) {
    return `Sen Cobrain'in ${route.name} agent'ısın. Türkçe, kısa, doğal cevaplar yaz.`;
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Grup mesajını ilgili agent profiliyle işle.
 */
export async function handleGroupMessage(
  userId: number,
  chatId: number,
  route: GroupRoute,
  text: string,
): Promise<string> {
  const userFolder = userManager.getUserFolder(userId);
  const systemPrompt = await buildRouteSystemPrompt(route, userFolder);
  const sessionKey = `${route.sessionKeyPrefix}_${chatId}`;

  const response = await chat(userId, text, undefined, undefined, {
    systemPromptOverride: systemPrompt,
    sessionKey,
    channel: `telegram:${route.name}`,
    silent: true, // Agent gruplarında tool bildirimleri ana chat'e düşmesin
  });

  return response.content;
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
  const systemPrompt = await buildRouteSystemPrompt(
    {
      name: route.name,
      mindDir: route.mindDir,
      sharedMindFiles: route.sharedMindFiles,
      sessionKeyPrefix: route.sessionKeyPrefix,
    },
    userFolder,
  );
  const sessionKey = `${route.sessionKeyPrefix}_${chatId}_${messageThreadId}`;

  const response = await chat(userId, text, undefined, undefined, {
    systemPromptOverride: systemPrompt,
    sessionKey,
    channel: `telegram:hub:${route.agentId}`,
    silent: true,
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

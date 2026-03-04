import { userManager } from "../services/user-manager.ts";
import { chat } from "../agent/chat.ts";
import { config } from "../config.ts";

interface GroupRoute {
  name: string;
  /** USER_FOLDER'a göre relative path: "agents/wa/mind" */
  mindDir: string;
  /** USER_FOLDER/mind/ altındaki paylaşılan dosyalar */
  sharedMindFiles: string[];
  /** Session key prefix: "tg_wa" → "tg_wa_<chatId>" */
  sessionKeyPrefix: string;
}

const GROUP_ROUTES = new Map<number, GroupRoute>();

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

export function getGroupRoute(chatId: number): GroupRoute | null {
  return GROUP_ROUTES.get(chatId) ?? null;
}

/**
 * Grup route'u için mind dosyalarından system prompt oluştur.
 */
async function buildRouteSystemPrompt(route: GroupRoute, userFolder: string): Promise<string> {
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

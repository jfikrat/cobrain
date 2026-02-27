/**
 * Stem — Haiku-based triage classifier.
 * Single-turn Agent SDK query() call per event, no tools, JSON output.
 */

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildTriagePrompt } from "./prompts.ts";
import type { StemConfig, StemEvent, TriageDecision } from "./types.ts";

export class Stem {
  private config: StemConfig;

  constructor(config: StemConfig) {
    this.config = config;
    console.log(`[Stem] Initialized (model=${config.model})`);
  }

  async triage(event: StemEvent): Promise<TriageDecision> {
    const eventMessage = formatEventMessage(event);
    console.log(`[Stem] triage: ${event.type}`);

    try {
      const t0 = Date.now();
      const systemPrompt = await buildTriagePrompt(this.config.userFolder);

      let lastContent = "";

      const queryResult = query({
        prompt: eventMessage,
        options: {
          model: this.config.model,
          systemPrompt,
          settingSources: [],
          mcpServers: {},
          maxTurns: 1,
        },
      });

      for await (const msg of queryResult) {
        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (typeof block === "object" && "text" in block) {
              lastContent = block.text as string;
            }
          }
        }
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success" && !lastContent && result.result) {
            lastContent = result.result;
          }
          if (result.subtype !== "success") {
            console.log(`[Stem] query error: ${result.subtype}`);
          }
        }
      }

      const elapsed = Date.now() - t0;
      const decision = parseTriageResponse(lastContent);
      console.log(`[Stem] decision: action=${decision.action} reason="${decision.reason}" (${elapsed}ms)`);
      return decision;
    } catch (err) {
      console.log(`[Stem] triage error: ${err instanceof Error ? err.message : String(err)}`);
      return { action: "ignore", reason: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseTriageResponse(text: string): TriageDecision {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log("[Stem] No JSON in response, defaulting to ignore:", text.slice(0, 200));
    return { action: "ignore", reason: "no_json_in_response" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.action;
    if (!["reply", "wake_cortex", "notify", "ignore"].includes(action)) {
      return { action: "ignore", reason: `invalid_action: ${action}` };
    }
    return {
      action,
      reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : "no_reason",
      urgency: parsed.urgency === "immediate" ? "immediate" : "soon",
    };
  } catch {
    console.log("[Stem] JSON parse failed:", text.slice(0, 200));
    return { action: "ignore", reason: "json_parse_error" };
  }
}

function formatEventMessage(event: StemEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  switch (event.type) {
    case "whatsapp_dm": {
      const p = event.payload;
      const senderName = (p.senderName as string) || "Bilinmeyen";
      const messages =
        (p.messages as Array<{ content?: string; message_type?: string }>) || [];
      const history =
        (p.conversationHistory as Array<{ content: string; direction: string }>) || [];
      const chatJid = (p.chatJid as string) || "";

      const historyText = history.length > 0
        ? `[SON ${history.length} MESAJ — Bağlam]\n${history
            .map((m) => `${m.direction === "outgoing" ? "Cobrain" : senderName}: ${m.content.slice(0, 150)}`)
            .join("\n")}\n\n`
        : "";

      const newMsgText = messages
        .map((m) => {
          const typeLabel =
            m.message_type && m.message_type !== "text"
              ? `[${m.message_type}] `
              : "";
          return `${typeLabel}${(m.content || "").slice(0, 300)}`;
        })
        .join("\n");

      return `[${time}] WhatsApp DM — ${senderName} (${chatJid}):\n${historyText}[YENİ MESAJLAR]\n${newMsgText}`;
    }

    case "whatsapp_group": {
      const p = event.payload;
      const groupName = (p.groupName as string) || "Grup";
      const messages =
        (p.messages as Array<{
          content?: string;
          sender_name?: string;
          message_type?: string;
        }>) || [];
      const chatJid = (p.chatJid as string) || "";
      const msgText = messages
        .map((m) => {
          const sender =
            ((m.sender_name || "") as string).split(" @ ")[0] || "?";
          const typeLabel =
            m.message_type && m.message_type !== "text"
              ? `[${m.message_type}] `
              : "";
          return `[${sender}]: ${typeLabel}${(m.content || "").slice(0, 200)}`;
        })
        .join("\n");
      return `[${time}] WhatsApp Grup — ${groupName} (${chatJid}):\n${msgText}`;
    }

    case "reminder_due": {
      const p = event.payload;
      return `[${time}] Hatırlatıcı tetiklendi: "${p.title}" — ${p.message || "(mesaj yok)"}`;
    }

    case "expectation_timeout": {
      const p = event.payload;
      return `[${time}] Beklenti timeout: [${p.type}] ${p.target} — ${p.context}`;
    }

    default:
      return `[${time}] Bilinmeyen olay: ${event.type}`;
  }
}

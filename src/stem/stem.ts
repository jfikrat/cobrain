/**
 * Stem — Haiku-based triage classifier.
 * Single messages.create() call per event, no tools, JSON output.
 */

import { buildTriagePrompt } from "./prompts.ts";
import type { StemConfig, StemEvent, TriageDecision } from "./types.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

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
      const systemPrompt = await buildTriagePrompt(this.config.userFolder);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error("[Stem] ANTHROPIC_API_KEY not set!");
        return { action: "ignore", reason: "no_api_key" };
      }

      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 256,
          system: systemPrompt,
          messages: [{ role: "user", content: eventMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.log(`[Stem] API error ${response.status}: ${errText.slice(0, 200)}`);
        return { action: "ignore", reason: `api_error_${response.status}` };
      }

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };

      const decision = parseTriageResponse(data);
      console.log(`[Stem] decision: action=${decision.action} reason="${decision.reason}"`);
      return decision;
    } catch (err) {
      console.log(`[Stem] triage error: ${err instanceof Error ? err.message : String(err)}`);
      return { action: "ignore", reason: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseTriageResponse(data: { content: Array<{ type: string; text?: string }> }): TriageDecision {
  const text = data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");

  // Extract JSON from response (may be wrapped in markdown code block)
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
  } catch (err) {
    console.log("[Stem] JSON parse failed:", err, text.slice(0, 200));
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
      const chatJid = (p.chatJid as string) || "";
      const msgText = messages
        .map((m) => {
          const typeLabel =
            m.message_type && m.message_type !== "text"
              ? `[${m.message_type}] `
              : "";
          return `${typeLabel}${(m.content || "").slice(0, 300)}`;
        })
        .join("\n");
      return `[${time}] WhatsApp DM — ${senderName} (${chatJid}):\n${msgText}`;
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

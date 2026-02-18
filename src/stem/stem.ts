/**
 * Stem — Haiku-based background watcher.
 * Processes events via Agent SDK query(), maintains a persistent notebook,
 * and auto-consolidates when context reaches ~85%.
 */

import {
  query,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { Notebook } from "./notebook.ts";
import { buildStemSystemPrompt } from "./prompts.ts";
import { createStemTools } from "./tools.ts";
import type { StemConfig, StemEvent, StemResult } from "./types.ts";

export class Stem {
  private sessionId: string | null = null;
  private notebook: Notebook;
  private estimatedTokens = 0;
  private running = false;
  private processing = false;
  private eventQueue: StemEvent[] = [];
  private config: StemConfig;
  private mcpServer: ReturnType<typeof createStemTools> | null = null;
  private bot: Bot | null = null;

  constructor(config: StemConfig) {
    this.config = config;
    this.notebook = new Notebook(config.notebookPath);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(bot: Bot): Promise<void> {
    this.bot = bot;
    this.mcpServer = createStemTools({
      notebook: this.notebook,
      bot,
      userId: this.config.userId,
      maxWakesPerHour: this.config.maxWakesPerHour,
    });
    this.running = true;
    console.log(`[Stem] Started (model=${this.config.model}, maxTurns=${this.config.maxTurns}, consolidation=${this.config.consolidationThreshold})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.notebook.flush();
    console.log("[Stem] Stopped");
  }

  // ── Public API ─────────────────────────────────────────────────────

  async feedEvent(event: StemEvent): Promise<StemResult> {
    if (!this.running) {
      return { action: "none", details: "stem_not_running" };
    }

    // Queue if already processing
    if (this.processing) {
      this.eventQueue.push(event);
      console.log(`[Stem] Event queued (queue=${this.eventQueue.length}): ${event.type}`);
      return { action: "none", details: "queued" };
    }

    return this.processEventWithQueue(event);
  }

  // ── Internal Processing ────────────────────────────────────────────

  private async processEventWithQueue(event: StemEvent): Promise<StemResult> {
    this.processing = true;
    let result: StemResult;

    try {
      result = await this.processEvent(event);
    } catch (err) {
      console.error("[Stem] processEvent error:", err);
      result = { action: "none", details: `error: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Process queued events
    while (this.eventQueue.length > 0 && this.running) {
      const next = this.eventQueue.shift()!;
      try {
        await this.processEvent(next);
      } catch (err) {
        console.error("[Stem] queued event error:", err);
      }
    }

    this.processing = false;
    return result;
  }

  private async processEvent(event: StemEvent): Promise<StemResult> {
    if (!this.mcpServer) {
      return { action: "none", details: "mcp_server_not_initialized" };
    }

    const eventMessage = this.formatEventMessage(event);
    console.log(`[Stem] feedEvent: ${event.type}`);

    try {
      const systemPrompt = buildStemSystemPrompt(this.notebook);

      let sessionId = "";
      let lastContent = "";
      let inputTokens = 0;
      let outputTokens = 0;

      const queryResult = query({
        prompt: eventMessage,
        options: {
          model: this.config.model,
          systemPrompt,
          resume: this.sessionId || undefined,
          settingSources: [],
          mcpServers: {
            stem: this.mcpServer,
          },
          maxTurns: this.config.maxTurns,
        },
      });

      for await (const msg of queryResult) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") {
              sessionId = msg.session_id;
              this.sessionId = sessionId;
            }
            break;

          case "assistant":
            // Extract text from assistant message
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (typeof block === "object" && "text" in block) {
                  lastContent = block.text;
                }
              }
            }
            break;

          case "result": {
            const result = msg as SDKResultMessage;
            if (result.subtype === "success") {
              inputTokens = result.usage?.input_tokens ?? 0;
              outputTokens = result.usage?.output_tokens ?? 0;
              if (!lastContent && result.result) {
                lastContent = result.result;
              }
            } else {
              console.error(`[Stem] Query error: ${result.subtype}`, (result as any).errors);
            }
            break;
          }
        }
      }

      // Update token estimate
      this.estimatedTokens += inputTokens;

      const action = this.inferAction(lastContent);
      console.log(`[Stem] Completed: action=${action} tokens=${inputTokens}in/${outputTokens}out estimated=${this.estimatedTokens}`);

      // Check consolidation threshold
      if (this.estimatedTokens > this.config.consolidationThreshold) {
        await this.consolidateAndReset();
      }

      return {
        action,
        details: lastContent.slice(0, 200),
        tokensUsed: inputTokens + outputTokens,
      };
    } catch (err) {
      console.error("[Stem] query error:", err);
      return {
        action: "none",
        details: `query_error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Consolidation ──────────────────────────────────────────────────

  private async consolidateAndReset(): Promise<void> {
    console.log(`[Stem] Consolidating... (estimated tokens: ${this.estimatedTokens})`);

    try {
      // Send consolidation message to stem
      if (this.mcpServer) {
        const consolidationPrompt =
          "KONSOLIDASYON: Context limitine yaklaşıyorsun. " +
          "1) update_notebook ile defterindeki tüm bölümleri güncelle (güncel durum, bekleyenler, öğrenilenler). " +
          "2) store_memory ile kalıcı bilgileri hafızaya kaydet. " +
          "3) 'CONSOLIDATED' yaz.";

        const queryResult = query({
          prompt: consolidationPrompt,
          options: {
            model: this.config.model,
            systemPrompt: buildStemSystemPrompt(this.notebook),
            resume: this.sessionId || undefined,
            settingSources: [],
            mcpServers: { stem: this.mcpServer },
            maxTurns: this.config.maxTurns,
          },
        });

        // Drain the generator
        for await (const _msg of queryResult) {
          // Just let it run through
        }
      }
    } catch (err) {
      console.error("[Stem] Consolidation error:", err);
    }

    // Reset session
    this.sessionId = null;
    this.estimatedTokens = 0;
    console.log("[Stem] Session reset after consolidation");
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private formatEventMessage(event: StemEvent): string {
    const time = new Date(event.timestamp).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    switch (event.type) {
      case "whatsapp_dm": {
        const p = event.payload;
        const senderName = p.senderName as string || "Bilinmeyen";
        const messages = p.messages as Array<{ content?: string; message_type?: string }> || [];
        const chatJid = p.chatJid as string || "";
        const msgText = messages
          .map((m) => {
            const typeLabel = m.message_type && m.message_type !== "text" ? `[${m.message_type}] ` : "";
            return `${typeLabel}${(m.content || "").slice(0, 300)}`;
          })
          .join("\n");
        return `[${time}] WhatsApp DM — ${senderName} (${chatJid}):\n${msgText}`;
      }

      case "whatsapp_group": {
        const p = event.payload;
        const groupName = p.groupName as string || "Grup";
        const messages = p.messages as Array<{ content?: string; sender_name?: string; message_type?: string }> || [];
        const chatJid = p.chatJid as string || "";
        const msgText = messages
          .map((m) => {
            const sender = ((m.sender_name || "") as string).split(" @ ")[0] || "?";
            const typeLabel = m.message_type && m.message_type !== "text" ? `[${m.message_type}] ` : "";
            return `[${sender}]: ${typeLabel}${(m.content || "").slice(0, 200)}`;
          })
          .join("\n");
        return `[${time}] WhatsApp Grup — ${groupName} (${chatJid}):\n${msgText}`;
      }

      case "reminder_due": {
        const p = event.payload;
        return `[${time}] Hatırlatıcı tetiklendi: "${p.title}" — ${p.message || "(mesaj yok)"}`;
      }

      case "periodic_check":
        return `[${time}] Periyodik kontrol — Bekleyen bir iş var mı? Beklentileri ve defteri kontrol et.`;

      case "expectation_timeout": {
        const p = event.payload;
        return `[${time}] Beklenti timeout: [${p.type}] ${p.target} — ${p.context}`;
      }

      default:
        return `[${time}] Bilinmeyen olay: ${event.type}`;
    }
  }

  /** Infer action from stem's response text */
  private inferAction(content: string): StemResult["action"] {
    const lower = content.toLowerCase();
    if (lower.includes("wake_opus") || lower.includes("opus'u uyandır")) return "woke_opus";
    if (lower.includes("mesaj gönderildi") || lower.includes("cevap gönderildi") || lower.includes("send_whatsapp_reply")) return "replied";
    if (lower.includes("telegram bildirimi") || lower.includes("send_telegram")) return "notified";
    if (lower.includes("defter güncellendi") || lower.includes("not al")) return "noted";
    return "none";
  }
}

/**
 * Hippocampus — Memory consolidation agent.
 *
 * Runs during low-activity periods (sleep cycle), like the human hippocampus
 * consolidating memories during sleep. Uses Haiku for reasoning.
 *
 * Triggered by BrainLoop when:
 *   - Night hours (03:00-04:00) OR
 *   - 2+ hours of user inactivity
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Bot } from "grammy";
import { FileMemory } from "../memory/file-memory.ts";
import { createHippocampusTools } from "./tools.ts";
import { buildHippocampusPrompt } from "./prompts.ts";
import { userManager } from "../services/user-manager.ts";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TURNS = 10;

export class Hippocampus {
  private lastRunDate: string | null = null;
  private running = false;

  async run(userId: number, bot: Bot): Promise<void> {
    if (this.running) {
      console.log("[Hippocampus] Already running, skipping.");
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (this.lastRunDate === today) {
      console.log("[Hippocampus] Already ran today, skipping.");
      return;
    }

    this.running = true;
    console.log(`[Hippocampus] Starting memory consolidation for user ${userId}...`);

    try {
      const userFolder = userManager.getUserFolder(userId);
      const memory = new FileMemory(userFolder);
      const mcpServer = createHippocampusTools({ memory, bot, userId });

      const systemPrompt = buildHippocampusPrompt(userId);
      const prompt = `Hafıza konsolidasyonunu başlat. Sırasıyla: eski olayları arşivle, son olaylardan gerçek çıkar, çakışanları çöz.`;

      let totalCost = 0;

      for await (const msg of query({ prompt, options: {
        model: MODEL,
        systemPrompt,
        maxTurns: MAX_TURNS,
        mcpServers: { hippocampus: mcpServer },
        settingSources: [],
      }})) {
        if (msg.type === "result") {
          totalCost = (msg as any).total_cost_usd ?? 0;
        }
      }

      this.lastRunDate = today;
      console.log(`[Hippocampus] Consolidation complete. Cost: $${totalCost.toFixed(4)}`);
    } catch (err) {
      console.error("[Hippocampus] Consolidation failed:", err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Should consolidation run now?
   * - Night hours (03:00-04:00 local time) and not yet run today
   * - OR: explicitly forced
   */
  shouldRun(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastRunDate === today) return false;
    if (this.running) return false;

    const hour = new Date().getHours();
    return hour === 3; // 03:00-03:59
  }
}

export const hippocampus = new Hippocampus();

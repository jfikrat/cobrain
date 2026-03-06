/**
 * Agent Loop Tool — agent_set_loop MCP Server
 *
 * Agent'ların kendi uyanma döngülerini kontrol etmesini sağlar.
 * loop.json dosyasını yazarak BrainLoop'un dinamik tetiklemesini yönetir.
 */

import { join } from "node:path";
import { rename } from "node:fs/promises";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { toolSuccess, toolError } from "../../utils/tool-response.ts";
import { userManager } from "../../services/user-manager.ts";
import { config } from "../../config.ts";

// ── Loop Config Type ─────────────────────────────────────────────────────────

export interface LoopConfig {
  intervalMs: number;
  precondition: string | null;
  activeIntervalMs: number | null;
  activeUntil: number | null;
  reason: string | null;
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  intervalMs: 3_600_000, // 1 saat
  precondition: null,
  activeIntervalMs: null,
  activeUntil: null,
  reason: null,
};

// ── Constraints ──────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 10_000;          // 10 saniye
const MAX_INTERVAL_MS = 86_400_000;      // 24 saat
const MAX_ACTIVE_DURATION_MS = 1_800_000; // 30 dakika

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLoopPath(agentId: string): string {
  const userFolder = userManager.getUserFolder(config.MY_TELEGRAM_ID);
  return join(userFolder, "agents", agentId, "loop.json");
}

export async function readLoopConfig(agentId: string): Promise<LoopConfig> {
  try {
    const path = getLoopPath(agentId);
    const file = Bun.file(path);
    if (await file.exists()) {
      const data = await file.json();
      return { ...DEFAULT_LOOP_CONFIG, ...data };
    }
  } catch (e) {
    console.warn("[AgentLoop] Loop config read failed:", e);
  }
  return { ...DEFAULT_LOOP_CONFIG };
}

async function writeLoopConfig(agentId: string, loopConfig: LoopConfig): Promise<void> {
  const path = getLoopPath(agentId);
  const tmp = `${path}.tmp.${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(loopConfig, null, 2));
  await rename(tmp, path);
}

// ── agent_set_loop Tool ──────────────────────────────────────────────────────

const agentSetLoopTool = tool(
  "agent_set_loop",
  "Kendi uyanma döngünü ayarla. intervalMs: normal kontrol aralığı (ms). activeIntervalMs + activeDurationMs: geçici hızlı mod (örn. aktif konuşma sırasında 15s).",
  {
    agentId: z.string().describe("Kendi agent ID'n"),
    intervalMs: z.number().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS).optional()
      .describe("Normal uyanma aralığı (ms). Min: 10000, Max: 86400000"),
    activeIntervalMs: z.number().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS).optional()
      .describe("Geçici hızlı interval (ms). Min: 10000"),
    activeDurationMs: z.number().min(MIN_INTERVAL_MS).max(MAX_ACTIVE_DURATION_MS).optional()
      .describe("Hızlı mod süresi (ms). Max: 1800000 (30dk)"),
    reason: z.string().max(200).optional()
      .describe("Debug/log bilgisi"),
  },
  async ({ agentId, intervalMs, activeIntervalMs, activeDurationMs, reason }) => {
    try {
      const current = await readLoopConfig(agentId);

      if (intervalMs !== undefined) {
        current.intervalMs = intervalMs;
      }

      if (activeIntervalMs !== undefined && activeDurationMs !== undefined) {
        current.activeIntervalMs = activeIntervalMs;
        current.activeUntil = Date.now() + activeDurationMs;
      } else if (activeIntervalMs === undefined && activeDurationMs === undefined) {
        // İkisi de verilmediyse mevcut değerleri koru
      } else {
        return toolError("agent_set_loop", new Error("activeIntervalMs ve activeDurationMs birlikte verilmeli"));
      }

      if (reason !== undefined) {
        current.reason = reason;
      }

      await writeLoopConfig(agentId, current);

      const effectiveInterval = (current.activeUntil && current.activeUntil > Date.now() && current.activeIntervalMs)
        ? current.activeIntervalMs
        : current.intervalMs;

      return toolSuccess(
        `Loop güncellendi: interval=${current.intervalMs}ms` +
        (current.activeIntervalMs ? `, activeInterval=${current.activeIntervalMs}ms (${Math.round((current.activeUntil! - Date.now()) / 1000)}s kaldı)` : "") +
        `. Efektif: ${effectiveInterval}ms`
      );
    } catch (err) {
      return toolError("agent_set_loop", err);
    }
  },
);

// ── MCP Server Factory ──────────────────────────────────────────────────────

export function createAgentLoopServer() {
  return createSdkMcpServer({
    name: "agent-loop",
    tools: [agentSetLoopTool],
  });
}

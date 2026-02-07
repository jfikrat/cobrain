/**
 * n8n Integration Tools for Cobrain Agent
 * Webhook-based workflow trigger, list and status tools
 *
 * n8n runs on fjds server (localhost:5678) with API key auth.
 * Cobrain triggers workflows via webhooks, n8n does the actual work
 * (Gmail, Calendar, Sheets, etc.)
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "../../config.ts";

// Helper for tool return types
function ok(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false as const };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/**
 * Make authenticated request to n8n API
 */
async function n8nFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const baseUrl = config.N8N_URL || "http://localhost:5678";
  const apiKey = config.N8N_API_KEY;

  if (!apiKey) {
    throw new Error("N8N_API_KEY ayarlanmamis");
  }

  const url = `${baseUrl}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
      ...options.headers,
    },
  });
}

// ============================================================
// n8n Tools
// ============================================================

const n8nStatusTool = tool(
  "n8n_status",
  "n8n baglanti durumunu kontrol eder. n8n'in calisiyor ve erisilebilir olup olmadigini doner.",
  {},
  async () => {
    try {
      const res = await n8nFetch("/api/v1/workflows?limit=1");

      if (!res.ok) {
        return fail(`n8n API hatasi: ${res.status} ${res.statusText}`);
      }

      return ok("n8n bagli ve calisiyor.");
    } catch (error) {
      return fail(`n8n'e baglanilamadi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const n8nListWorkflowsTool = tool(
  "n8n_list_workflows",
  "n8n'deki aktif workflow'lari listeler. Her workflow'un ID, isim ve durumunu gosterir.",
  {
    activeOnly: z.boolean().default(true).describe("Sadece aktif workflow'lari goster"),
  },
  async ({ activeOnly }) => {
    try {
      const res = await n8nFetch("/api/v1/workflows?limit=100");

      if (!res.ok) {
        return fail(`n8n API hatasi: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as { data: Array<{ id: string; name: string; active: boolean; createdAt: string }> };
      let workflows = data.data || [];

      if (activeOnly) {
        workflows = workflows.filter((w) => w.active);
      }

      if (workflows.length === 0) {
        return ok(activeOnly ? "Aktif workflow bulunamadi." : "Hic workflow bulunamadi.");
      }

      const list = workflows
        .map((w, i) => `${i + 1}. ${w.name}\n   ID: ${w.id} | Durum: ${w.active ? "Aktif" : "Pasif"}`)
        .join("\n\n");

      return ok(`${workflows.length} workflow:\n\n${list}`);
    } catch (error) {
      return fail(`Workflow listesi alinamadi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

const n8nTriggerTool = tool(
  "n8n_trigger",
  "n8n workflow'unu webhook ile tetikler. Workflow'a veri gonderir ve sonucunu doner. Mail gonderme, Google Sheets, Calendar gibi islemleri n8n uzerinden yapar.",
  {
    webhookPath: z.string().describe("Webhook path (ornek: '/webhook/gmail-send' veya '/webhook-test/gmail-send')"),
    payload: z.record(z.string(), z.unknown()).default({}).describe("Workflow'a gonderilecek JSON verisi"),
    method: z.enum(["GET", "POST"]).default("POST").describe("HTTP metodu"),
    waitForResponse: z.boolean().default(true).describe("Workflow tamamlanana kadar bekle (production webhook'larda true)"),
  },
  async ({ webhookPath, payload, method, waitForResponse }) => {
    try {
      const baseUrl = config.N8N_URL || "http://localhost:5678";
      // Webhook path'i normalize et
      const path = webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`;
      const url = `${baseUrl}${path}`;

      const fetchOptions: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };

      if (method === "POST") {
        fetchOptions.body = JSON.stringify(payload);
      }

      const res = await fetch(url, fetchOptions);

      if (!res.ok) {
        const errorText = await res.text();
        return fail(`n8n webhook hatasi (${res.status}): ${errorText}`);
      }

      if (!waitForResponse) {
        return ok("Workflow tetiklendi (asenkron, sonuc beklenmedi).");
      }

      // Parse response
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const result = await res.json();
        return ok(`Workflow tamamlandi:\n${JSON.stringify(result, null, 2)}`);
      }

      const text = await res.text();
      return ok(`Workflow tamamlandi:\n${text}`);
    } catch (error) {
      return fail(`Workflow tetiklenemedi: ${error instanceof Error ? error.message : "Bilinmeyen hata"}`);
    }
  }
);

// ============================================================
// MCP Server Factory
// ============================================================

export function createN8nServer() {
  return createSdkMcpServer({
    name: "cobrain-n8n",
    version: "1.0.0",
    tools: [n8nStatusTool, n8nListWorkflowsTool, n8nTriggerTool],
  });
}

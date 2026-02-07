#!/usr/bin/env bun
/**
 * Standalone Google Drive MCP Server
 * rclone wrapper — gateway üzerinden çalışır
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { $ } from "bun";

async function rclone(args: string[]): Promise<{ output: string; error?: string }> {
  try {
    const result = await $`rclone ${args}`.quiet();
    return { output: result.stdout.toString().trim() };
  } catch (error) {
    return { output: "", error: error instanceof Error ? error.message : "rclone hatası" };
  }
}

const TOOLS = [
  {
    name: "gdrive_list",
    description: "Google Drive'da dosyaları listele",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Drive yolu (örn: 'Belgeler')", default: "" },
        recursive: { type: "boolean", description: "Alt klasörleri dahil et", default: false },
      },
    },
  },
  {
    name: "gdrive_dirs",
    description: "Google Drive'da sadece klasörleri listele",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Drive yolu", default: "" },
      },
    },
  },
  {
    name: "gdrive_link",
    description: "Google Drive dosyası için paylaşılabilir link oluştur",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Dosya yolu (örn: 'Belgeler/rapor.pdf')" },
      },
      required: ["path"],
    },
  },
  {
    name: "gdrive_info",
    description: "Google Drive dosyası hakkında bilgi al (boyut, tarih)",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Dosya yolu" },
      },
      required: ["path"],
    },
  },
  {
    name: "gdrive_search",
    description: "Google Drive'da dosya ara",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Arama terimi" },
        path: { type: "string", description: "Arama klasörü", default: "" },
      },
      required: ["query"],
    },
  },
];

const server = new Server(
  { name: "gdrive", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "gdrive_list": {
      const path = (a.path as string) || "";
      const recursive = a.recursive as boolean;
      const rcloneArgs = recursive ? ["lsf", "-R", `gdrive:${path}`] : ["lsf", `gdrive:${path}`];
      const { output, error } = await rclone(rcloneArgs);
      if (error) return { content: [{ type: "text", text: `Drive hatası: ${error}` }], isError: true };
      if (!output) return { content: [{ type: "text", text: "Klasör boş veya bulunamadı." }] };
      const files = output.split("\n").slice(0, 50);
      const hasMore = output.split("\n").length > 50;
      return { content: [{ type: "text", text: `gdrive:${path || "/"} içeriği:\n${files.join("\n")}${hasMore ? "\n... (daha fazla var)" : ""}` }] };
    }

    case "gdrive_dirs": {
      const path = (a.path as string) || "";
      const { output, error } = await rclone(["lsd", `gdrive:${path}`]);
      if (error) return { content: [{ type: "text", text: `Drive hatası: ${error}` }], isError: true };
      if (!output) return { content: [{ type: "text", text: "Alt klasör bulunamadı." }] };
      const dirs = output.split("\n").map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
      return { content: [{ type: "text", text: `gdrive:${path || "/"} klasörleri:\n${dirs.join("\n")}` }] };
    }

    case "gdrive_link": {
      const { output, error } = await rclone(["link", `gdrive:${a.path}`]);
      if (error) return { content: [{ type: "text", text: `Link oluşturulamadı: ${error}` }], isError: true };
      return { content: [{ type: "text", text: `Paylaşılabilir link:\n${output}` }] };
    }

    case "gdrive_info": {
      const { output, error } = await rclone(["lsl", `gdrive:${a.path}`]);
      if (error) return { content: [{ type: "text", text: `Bilgi alınamadı: ${error}` }], isError: true };
      return { content: [{ type: "text", text: output || "Dosya bulunamadı." }] };
    }

    case "gdrive_search": {
      const path = (a.path as string) || "";
      const { output, error } = await rclone(["lsf", "-R", "--include", `*${a.query}*`, `gdrive:${path}`]);
      if (error) return { content: [{ type: "text", text: `Arama hatası: ${error}` }], isError: true };
      if (!output) return { content: [{ type: "text", text: `"${a.query}" için sonuç bulunamadı.` }] };
      const files = output.split("\n").slice(0, 30);
      const hasMore = output.split("\n").length > 30;
      return { content: [{ type: "text", text: `"${a.query}" sonuçları:\n${files.join("\n")}${hasMore ? "\n... (daha fazla var)" : ""}` }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[gdrive] MCP server started\n");

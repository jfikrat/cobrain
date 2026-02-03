/**
 * Google Drive Tools for Cobrain Agent
 * MCP tools for rclone-based Google Drive operations
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { $ } from "bun";

/**
 * Execute rclone command
 */
async function rclone(args: string[]): Promise<{ output: string; error?: string }> {
  try {
    const result = await $`rclone ${args}`.quiet();
    return { output: result.stdout.toString().trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "rclone hatası";
    return { output: "", error: message };
  }
}

/**
 * List files in Google Drive
 */
export const gdriveListTool = tool(
  "gdrive_list",
  "Google Drive'da dosyaları listele. Varsayılan olarak kök dizini listeler.",
  {
    path: z.string().default("").describe("Drive yolu (örn: 'Belgeler' veya 'Projeler/2024')"),
    recursive: z.boolean().default(false).describe("Alt klasörleri de dahil et"),
  },
  async ({ path, recursive }) => {
    const args = recursive ? ["lsf", "-R", `gdrive:${path}`] : ["lsf", `gdrive:${path}`];
    const { output, error } = await rclone(args);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Drive hatası: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: "Klasör boş veya bulunamadı." }],
      };
    }

    const files = output.split("\n").slice(0, 50); // Max 50 dosya göster
    const hasMore = output.split("\n").length > 50;

    return {
      content: [
        {
          type: "text" as const,
          text: `gdrive:${path || "/"} içeriği:\n${files.join("\n")}${hasMore ? "\n... (daha fazla var)" : ""}`,
        },
      ],
    };
  }
);

/**
 * List directories only
 */
export const gdriveDirsTool = tool(
  "gdrive_dirs",
  "Google Drive'da sadece klasörleri listele.",
  {
    path: z.string().default("").describe("Drive yolu"),
  },
  async ({ path }) => {
    const { output, error } = await rclone(["lsd", `gdrive:${path}`]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Drive hatası: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: "Alt klasör bulunamadı." }],
      };
    }

    // Parse lsd output (format: "          -1 2024-01-15 10:30:00        -1 FolderName")
    const dirs = output
      .split("\n")
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return parts[parts.length - 1]; // Son eleman klasör adı
      })
      .filter(Boolean);

    return {
      content: [
        {
          type: "text" as const,
          text: `gdrive:${path || "/"} klasörleri:\n${dirs.join("\n")}`,
        },
      ],
    };
  }
);

/**
 * Create shareable link
 */
export const gdriveLinkTool = tool(
  "gdrive_link",
  "Google Drive dosyası için paylaşılabilir link oluştur.",
  {
    path: z.string().describe("Dosya yolu (örn: 'Belgeler/rapor.pdf')"),
  },
  async ({ path }) => {
    const { output, error } = await rclone(["link", `gdrive:${path}`]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Link oluşturulamadı: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Paylaşılabilir link:\n${output}`,
        },
      ],
    };
  }
);

/**
 * Get file info
 */
export const gdriveInfoTool = tool(
  "gdrive_info",
  "Google Drive dosyası hakkında bilgi al (boyut, tarih, vb.).",
  {
    path: z.string().describe("Dosya yolu"),
  },
  async ({ path }) => {
    const { output, error } = await rclone(["lsl", `gdrive:${path}`]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Bilgi alınamadı: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text: output || "Dosya bulunamadı." }],
    };
  }
);

/**
 * Search files
 */
export const gdriveSearchTool = tool(
  "gdrive_search",
  "Google Drive'da dosya ara.",
  {
    query: z.string().describe("Arama terimi (dosya adında aranır)"),
    path: z.string().default("").describe("Arama yapılacak klasör"),
  },
  async ({ query, path }) => {
    const { output, error } = await rclone([
      "lsf",
      "-R",
      "--include",
      `*${query}*`,
      `gdrive:${path}`,
    ]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Arama hatası: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: `"${query}" için sonuç bulunamadı.` }],
      };
    }

    const files = output.split("\n").slice(0, 30);
    const hasMore = output.split("\n").length > 30;

    return {
      content: [
        {
          type: "text" as const,
          text: `"${query}" araması sonuçları:\n${files.join("\n")}${hasMore ? "\n... (daha fazla var)" : ""}`,
        },
      ],
    };
  }
);

/**
 * Create Google Drive MCP server
 */
export function createGDriveServer() {
  return createSdkMcpServer({
    name: "cobrain-gdrive",
    version: "1.0.0",
    tools: [
      gdriveListTool,
      gdriveDirsTool,
      gdriveLinkTool,
      gdriveInfoTool,
      gdriveSearchTool,
    ],
  });
}

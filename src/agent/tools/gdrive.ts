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
    const message = error instanceof Error ? error.message : "rclone error";
    return { output: "", error: message };
  }
}

/**
 * List files in Google Drive
 */
export const gdriveListTool = tool(
  "gdrive_list",
  "List files in Google Drive. Defaults to the root directory.",
  {
    path: z.string().default("").describe("Drive path (e.g. 'Documents' or 'Projects/2024')"),
    recursive: z.boolean().default(false).describe("Include subfolders"),
  },
  async ({ path, recursive }) => {
    const args = recursive ? ["lsf", "-R", `gdrive:${path}`] : ["lsf", `gdrive:${path}`];
    const { output, error } = await rclone(args);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Drive error: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: "Folder is empty or not found." }],
      };
    }

    const files = output.split("\n").slice(0, 50); // Show max 50 files
    const hasMore = output.split("\n").length > 50;

    return {
      content: [
        {
          type: "text" as const,
          text: `Contents of gdrive:${path || "/"}:\n${files.join("\n")}${hasMore ? "\n... (more available)" : ""}`,
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
  "List only folders in Google Drive.",
  {
    path: z.string().default("").describe("Drive path"),
  },
  async ({ path }) => {
    const { output, error } = await rclone(["lsd", `gdrive:${path}`]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Drive error: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: "No subfolders found." }],
      };
    }

    // Parse lsd output (format: "          -1 2024-01-15 10:30:00        -1 FolderName")
    const dirs = output
      .split("\n")
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return parts[parts.length - 1]; // Last item is the folder name
      })
      .filter(Boolean);

    return {
      content: [
        {
          type: "text" as const,
          text: `Folders in gdrive:${path || "/"}:\n${dirs.join("\n")}`,
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
  "Create a shareable link for a Google Drive file.",
  {
    path: z.string().describe("File path (e.g. 'Documents/report.pdf')"),
  },
  async ({ path }) => {
    const { output, error } = await rclone(["link", `gdrive:${path}`]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Could not create link: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Shareable link:\n${output}`,
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
  "Get info about a Google Drive file (size, date, etc.).",
  {
    path: z.string().describe("File path"),
  },
  async ({ path }) => {
    const { output, error } = await rclone(["lsl", `gdrive:${path}`]);

    if (error) {
      return {
        content: [{ type: "text" as const, text: `Could not get info: ${error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text: output || "File not found." }],
    };
  }
);

/**
 * Search files
 */
export const gdriveSearchTool = tool(
  "gdrive_search",
  "Search files in Google Drive.",
  {
    query: z.string().describe("Search term (matched against file names)"),
    path: z.string().default("").describe("Folder to search in"),
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
        content: [{ type: "text" as const, text: `Search error: ${error}` }],
        isError: true,
      };
    }

    if (!output) {
      return {
        content: [{ type: "text" as const, text: `No results found for "${query}".` }],
      };
    }

    const files = output.split("\n").slice(0, 30);
    const hasMore = output.split("\n").length > 30;

    return {
      content: [
        {
          type: "text" as const,
          text: `Search results for "${query}":\n${files.join("\n")}${hasMore ? "\n... (more available)" : ""}`,
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

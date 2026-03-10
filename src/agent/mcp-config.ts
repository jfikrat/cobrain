/**
 * User MCP Server Config Loader
 *
 * Reads ~/.cobrain/mcp-servers.json and returns MCP server definitions
 * compatible with Agent SDK's mcpServers format.
 *
 * Example mcp-servers.json:
 * {
 *   "filesystem": {
 *     "command": "npx",
 *     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/documents"]
 *   },
 *   "github": {
 *     "command": "npx",
 *     "args": ["-y", "@modelcontextprotocol/server-github"],
 *     "env": { "GITHUB_TOKEN": "ghp_xxx" }
 *   }
 * }
 */

import { join } from "node:path";
import { config } from "../config.ts";

interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpServersConfig = Record<string, McpServerEntry>;

type SdkMcpServer = {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
};

let _cache: Record<string, SdkMcpServer> | null = null;
let _loadedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 min

export async function loadUserMcpServers(): Promise<Record<string, SdkMcpServer>> {
  const now = Date.now();
  if (_cache && now - _loadedAt < CACHE_TTL_MS) return _cache;

  const configPath = join(config.COBRAIN_BASE_PATH, "mcp-servers.json");

  try {
    const file = Bun.file(configPath);
    if (!await file.exists()) {
      _cache = {};
      _loadedAt = now;
      return _cache;
    }

    const raw: McpServersConfig = await file.json();
    const servers: Record<string, SdkMcpServer> = {};

    for (const [name, entry] of Object.entries(raw)) {
      if (!entry.command) {
        console.warn(`[MCP Config] Skipping "${name}": missing command`);
        continue;
      }
      servers[name] = {
        type: "stdio",
        command: entry.command,
        args: entry.args || [],
        ...(entry.env && { env: entry.env }),
      };
    }

    const count = Object.keys(servers).length;
    if (count > 0) {
      console.log(`[MCP Config] Loaded ${count} user MCP server(s): ${Object.keys(servers).join(", ")}`);
    }

    _cache = servers;
    _loadedAt = now;
    return servers;
  } catch (err) {
    console.warn(`[MCP Config] Failed to load ${configPath}:`, err);
    _cache = {};
    _loadedAt = now;
    return {};
  }
}

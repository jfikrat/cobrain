/**
 * Tool Response Helpers
 * Standard response formats for MCP tools
 */

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Create an error response
 */
export function toolError(prefix: string, error: unknown): ToolResponse {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    content: [{ type: "text" as const, text: `${prefix}: ${message}` }],
    isError: true,
  };
}

/**
 * Create a success response
 */
export function toolSuccess(text: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Create a JSON success response
 */
export function toolJson<T>(data: T, pretty = true): ToolResponse {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Tool Response Helpers
 * MCP tool'ları için standart response formatları
 */

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Error response oluştur
 */
export function toolError(prefix: string, error: unknown): ToolResponse {
  const message = error instanceof Error ? error.message : "Bilinmeyen hata";
  return {
    content: [{ type: "text" as const, text: `${prefix}: ${message}` }],
    isError: true,
  };
}

/**
 * Success response oluştur
 */
export function toolSuccess(text: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * JSON success response oluştur
 */
export function toolJson<T>(data: T, pretty = true): ToolResponse {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text }],
  };
}

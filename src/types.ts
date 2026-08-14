/**
 * Minimal MCP wire types used by the gateway. Handlers read/write these objects and
 * let the SDK `Server` validate against the full protocol schemas.
 */

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
}

export interface ContentBlock {
  type: "text" | "image" | "audio" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: unknown;
  [key: string]: unknown;
}

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(value, null, 2), isError);
}

export function errorResult(message: string): CallToolResult {
  return textResult(message, true);
}

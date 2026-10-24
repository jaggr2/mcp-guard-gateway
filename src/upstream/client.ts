import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "../types";

export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface UpstreamToolsResponse {
  tools: UpstreamTool[];
  nextCursor?: string;
}

export interface InitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  capabilities?: unknown;
}

export interface UpstreamConfig {
  namespace: string;
  displayName: string;
  url: string;
  protocolVersion: string | null;
  headers: Record<string, string>;
}

export interface UpstreamClient {
  readonly namespace: string;
  readonly displayName: string;
  readonly url: string;
  toolsList(cursor?: string): Promise<UpstreamToolsResponse>;
  callTool(name: string, args: Record<string, unknown>, caller?: string): Promise<CallToolResult>;
  initialize(): Promise<InitializeResult>;
  snapshot(): Promise<{ serverInfo?: InitializeResult["serverInfo"]; instructions?: string; tools: UpstreamTool[] }>;
}

let requestCounter = 0;
const nextId = (): number => ++requestCounter;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a possibly-SSE upstream body into the JSON-RPC message object. We bias
 * toward JSON via the `Accept` header, but a conforming MCP server may answer
 * with `text/event-stream`.
 */
type UpstreamMessage = { result?: unknown; error?: { code?: number; message?: string } };

async function parseUpstreamResponse(response: Response): Promise<UpstreamMessage> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const raw = await response.text();
    const lastData = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((data) => data.length > 0)
      .pop();
    if (!lastData) {
      throw new McpError(ErrorCode.InternalError, "Upstream returned an empty SSE stream");
    }
    return JSON.parse(lastData) as UpstreamMessage;
  }
  return (await response.json()) as UpstreamMessage;
}

/** A single configured MCP upstream (NanoKVM today, any HTTP MCP server tomorrow). */
export class UpstreamClientImpl implements UpstreamClient {
  constructor(readonly config: UpstreamConfig) {}

  get namespace(): string {
    return this.config.namespace;
  }

  get displayName(): string {
    return this.config.displayName;
  }

  get url(): string {
    return this.config.url;
  }

  private headers(caller?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const protocolVersion = this.config.protocolVersion;
    if (protocolVersion) {
      headers["MCP-Protocol-Version"] = protocolVersion;
    }
    if (typeof caller === "string" && caller.length > 0) {
      headers["X-Warden-Caller"] = caller;
    }
    for (const [name, value] of Object.entries(this.config.headers)) {
      if (name.toLowerCase() !== "authorization" || !headers.Authorization) {
        headers[name] = value;
      }
    }
    return headers;
  }

  private async request(method: string, params?: unknown, caller?: string): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params });
    let response: Response;
    try {
      response = await fetch(this.config.url, { method: "POST", headers: this.headers(caller), body });
    } catch (err) {
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream ${this.namespace} unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream ${this.namespace} HTTP ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }
    let message: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = await parseUpstreamResponse(response);
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, `Upstream ${this.namespace} returned invalid JSON-RPC: ${String(err)}`);
    }
    if (message.error) {
      throw new McpError(message.error.code ?? ErrorCode.InternalError, message.error.message ?? "Upstream request failed");
    }
    return message.result;
  }

  async toolsList(cursor?: string): Promise<UpstreamToolsResponse> {
    const params = cursor ? { cursor } : {};
    const result = await this.request("tools/list", params);
    const tools = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
    const nextCursor = isObject(result) && typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    return { tools: tools as UpstreamTool[], nextCursor };
  }

  async callTool(name: string, args: Record<string, unknown>, caller?: string): Promise<CallToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, caller);
    if (isObject(result)) {
      return result as unknown as CallToolResult;
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  async initialize(): Promise<InitializeResult> {
    const result = (await this.request("initialize", {
      protocolVersion: this.config.protocolVersion ?? "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-guard-gateway", version: "0.1.0" },
    })) as Record<string, unknown> | undefined;
    if (!isObject(result)) {
      return {};
    }
    return {
      protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : undefined,
      serverInfo: isObject(result.serverInfo)
        ? {
            name: typeof result.serverInfo.name === "string" ? result.serverInfo.name : undefined,
            version: typeof result.serverInfo.version === "string" ? result.serverInfo.version : undefined,
          }
        : undefined,
      instructions: typeof result.instructions === "string" ? result.instructions : undefined,
      capabilities: result.capabilities,
    };
  }

  async snapshot(): Promise<{ serverInfo?: InitializeResult["serverInfo"]; instructions?: string; tools: UpstreamTool[] }> {
    const init = await this.initialize();
    const { tools } = await this.toolsList();
    return { serverInfo: init.serverInfo, instructions: init.instructions, tools };
  }
}

/** Namespaces an upstream tool name with the configured prefix. */
export function namespaceTool(upstream: { namespace: string }, tool: UpstreamTool): Tool {
  return { ...tool, name: `${upstream.namespace}_${tool.name}` };
}

/** Strips the namespace prefix before forwarding a call upstream. */
export function stripNamespace(namespace: string, name: string): string | null {
  const prefix = `${namespace}_`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

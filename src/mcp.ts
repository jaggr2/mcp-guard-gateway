import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "./config";
import type { Deps } from "./deps";
import { SqliteStore } from "./store/sqlite";
import { ConfigStore } from "./store/config";
import { SecretBox } from "./secrets";
import { UpstreamRegistry } from "./upstream/registry";
import { namespaceTool, stripNamespace, type UpstreamClient } from "./upstream/client";
import { TrustService } from "./trust/service";
import type { HermesBridge } from "./hermes/bridge";
import { NoopHermesBridge } from "./hermes/bridge";
import { injectReasonSchema, requiresReason, resolvePolicy } from "./policy";
import { startApproval } from "./guards/hitl";
import { assertReason, extractReason, recordAudit, stripReason } from "./guards/reason";
import { callGatewayTool, GATEWAY_TOOLS, GATEWAY_TOOL_NAMES } from "./tools/gateway";
import type { CallToolResult, Tool } from "./types";
import { errorResult, jsonResult } from "./types";

export function buildDeps(
  config: GatewayConfig,
  db: Database.Database,
  callerId: string,
  groups: string[],
  hermes?: HermesBridge
): Deps {
  const configStore = new ConfigStore(db);
  const secrets = new SecretBox(config.masterKey);
  const registry = new UpstreamRegistry(configStore, secrets);
  const bridge = hermes ?? new NoopHermesBridge();
  const trust = new TrustService(configStore, registry, {
    notify: (namespace, message) => bridge.notify(`${namespace}: ${message}`),
  });
  return {
    config,
    store: new SqliteStore(db),
    configStore,
    registry,
    trust,
    hermes: bridge,
    callerId,
    groups,
  };
}

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => typeof b.text === "string");
  return block?.text ?? "";
}

/**
 * Builds the MCP server. `tools/list` merges every configured, pinned, enabled
 * upstream (namespaced) with the gateway-native tools; `tools/call` applies the
 * per-tool policy guards before forwarding.
 */
export function buildMcpServer(deps: Deps): Server {
  const server = new Server(
    { name: "mcp-guard-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const tools: Tool[] = [];
    for (const client of deps.registry.list()) {
      const check = await deps.trust.checkAndServe(client.namespace, client);
      if (!check.ok) {
        // Blocked (unpinned/drift/error) — omit this upstream's tools entirely.
        continue;
      }
      for (const rawTool of check.tools) {
        const tool = namespaceTool(client, rawTool);
        const policy = resolvePolicy(deps.configStore, client.namespace, tool.name);
        if (!policy.enabled) {
          continue; // fail-closed: disabled until an admin enables it
        }
        if (requiresReason(policy)) {
          tool.inputSchema = injectReasonSchema(tool.inputSchema);
        }
        tools.push(tool);
      }
    }
    const nextCursor = request.params?.cursor;
    return { tools: [...tools, ...GATEWAY_TOOLS], ...(nextCursor ? { nextCursor } : {}) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    return callTool(deps, name, args);
  });

  return server;
}

async function callTool(
  deps: Deps,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  if (GATEWAY_TOOL_NAMES.has(name)) {
    return callGatewayTool(deps, name, args);
  }

  const client = findUpstreamForTool(deps, name);
  if (!client) {
    return errorResult(`Unknown tool: ${name}`);
  }

  const policy = resolvePolicy(deps.configStore, client.namespace, name);
  if (!policy.enabled) {
    return errorResult(`Tool "${name}" is disabled`);
  }

  const reason = extractReason(args);
  const cleanArgs = stripReason(args);

  if (requiresReason(policy)) {
    assertReason(reason); // throws JSON-RPC -32602 on missing/blank reason
  }

  if (policy.guard === "hitl") {
    const started = await startApproval(deps, name, cleanArgs, reason as string, policy);
    return jsonResult(started);
  }

  let result: CallToolResult;
  try {
    result = await client.callTool(name.slice(`${client.namespace}_`.length), cleanArgs);
  } catch (err) {
    result = errorResult(
      `Upstream execution failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  await recordAudit(
    { store: deps.store, callerId: deps.callerId },
    name,
    cleanArgs,
    reason,
    "auto-audited",
    { upstreamStatus: result.isError ? `error: ${firstText(result)}` : "ok" }
  );
  return result;
}

function findUpstreamForTool(deps: Deps, name: string): UpstreamClient | null {
  for (const client of deps.registry.list()) {
    if (stripNamespace(client.namespace, name) !== null) {
      return client;
    }
  }
  return null;
}

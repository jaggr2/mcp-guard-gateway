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
import {
  enforceRepoBoundary,
  isUpstreamAllowedForProject,
  LoopCircuitBreaker,
  sanitizeInboundToolResult,
  scanOutboundSecrets,
} from "./guards/security";
import { callGatewayTool, GATEWAY_TOOLS, GATEWAY_TOOL_NAMES } from "./tools/gateway";
import type { CallToolResult, Tool } from "./types";
import { errorResult, jsonResult } from "./types";

const circuitBreaker = new LoopCircuitBreaker();

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
 * upstream (namespaced & filtered by per-project ACLs) with the gateway-native tools;
 * `tools/call` applies the MCP Security Fortress guards before and after forwarding.
 */
export function buildMcpServer(deps: Deps): Server {
  const server = new Server(
    { name: "warden-gateway", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const callerProject = deps.configStore.getProject(deps.callerId);
    const tools: Tool[] = [];
    for (const client of deps.registry.list()) {
      if (!isUpstreamAllowedForProject(callerProject, client.namespace)) {
        continue; // hidden from sandboxes not granted this upstream
      }
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

  const callerProject = deps.configStore.getProject(deps.callerId);
  if (!isUpstreamAllowedForProject(callerProject, client.namespace)) {
    await recordAudit(
      { store: deps.store, callerId: deps.callerId },
      name,
      args,
      undefined,
      "denied",
      { upstreamStatus: "blocked by project allowed_upstreams" }
    );
    return errorResult(
      `[Warden ACL Guard] Sandbox '${deps.callerId}' is not permitted to use upstream '${client.namespace}'`
    );
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

  // Guard: Repo boundary check for GitHub tools
  const repoGuard = enforceRepoBoundary(callerProject, name, cleanArgs);
  if (!repoGuard.ok) {
    await recordAudit(
      { store: deps.store, callerId: deps.callerId },
      name,
      cleanArgs,
      reason,
      "denied",
      { upstreamStatus: repoGuard.reason }
    );
    return errorResult(repoGuard.reason);
  }

  // Guard: Outbound secret leak check
  const secretBox = new SecretBox(deps.config.masterKey);
  const decryptedSecrets: string[] = [];
  for (const ct of deps.configStore.listSecretCiphertexts()) {
    try {
      decryptedSecrets.push(secretBox.decrypt(ct));
    } catch {
      /* ignore */
    }
  }
  const secretScan = scanOutboundSecrets(cleanArgs, decryptedSecrets);
  if (!secretScan.ok) {
    const msg = `[Warden Secret Guard] Blocked outbound tool call containing leaked credential (${secretScan.match})`;
    await recordAudit(
      { store: deps.store, callerId: deps.callerId },
      name,
      { redacted: true },
      reason,
      "denied",
      { upstreamStatus: msg }
    );
    void deps.hermes.notify(`${msg} from caller '${deps.callerId}' on tool '${name}'`);
    return errorResult(msg);
  }

  // Guard: Loop & velocity circuit breaker
  const loopCheck = circuitBreaker.checkBeforeCall(deps.callerId, name, cleanArgs);
  if (!loopCheck.ok) {
    void deps.hermes.notify(loopCheck.reason);
    return errorResult(loopCheck.reason);
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

  circuitBreaker.recordOutcome(deps.callerId, name, cleanArgs, Boolean(result.isError));

  // Guard: Inbound prompt-injection & hidden-Unicode sanitizer
  const sanitized = sanitizeInboundToolResult(result);
  result = sanitized.result;
  if (sanitized.sanitizedFlags.length > 0) {
    void deps.hermes.notify(
      `⚠️ [Warden Prompt-Injection Guard] Sanitized ${sanitized.sanitizedFlags.join(", ")} in response from '${name}'`
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

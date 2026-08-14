import type Database from "better-sqlite3";
import { loadConfig, type GatewayConfig } from "../src/config";
import { openDatabase } from "../src/db/connection";
import type { Deps } from "../src/deps";
import { SecretBox } from "../src/secrets";
import { SqliteStore } from "../src/store/sqlite";
import { ConfigStore } from "../src/store/config";
import { UpstreamRegistry } from "../src/upstream/registry";
import { TrustService } from "../src/trust/service";
import type { HermesBridge } from "../src/hermes/bridge";
import type { UpstreamTool } from "../src/upstream/client";

export class FakeHermes implements HermesBridge {
  cards: { tool: string; reason: string; args: Record<string, unknown>; approvalId: string }[] = [];
  notifications: string[] = [];

  async sendApprovalCard(
    tool: string,
    reason: string,
    args: Record<string, unknown>,
    approvalId: string
  ): Promise<string> {
    this.cards.push({ tool, reason, args, approvalId });
    return `telegram:card:${this.cards.length}`;
  }

  async notify(message: string): Promise<void> {
    this.notifications.push(message);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    dbPath: ":memory:",
    host: "127.0.0.1",
    port: 8080,
    publicUrl: "https://mcp-guard.example",
    masterKey: "test-master-key",
    hermesBridgeUrl: "http://hermes-bridge:8643",
    hermesConversationKey: null,
    issuers: [],
    identityHeader: "Remote-Email",
    groupsHeader: "Remote-Groups",
    adminGroups: ["admins"],
    operatorGroups: ["operators"],
    bootstrapUpstream: null,
    seedUpstreams: [],
    seedSecrets: {},
    seedPolicies: [],
    protocolVersion: null,
    ...overrides,
  };
}

export type TestDeps = Deps & { db: Database.Database; hermes: FakeHermes };

export function makeDeps(overrides: Partial<Deps> = {}, config?: GatewayConfig): TestDeps {
  const cfg = config ?? testConfig();
  const db = openDatabase(cfg.dbPath);
  const configStore = new ConfigStore(db);
  const secrets = new SecretBox(cfg.masterKey);
  const registry = new UpstreamRegistry(configStore, secrets);
  const trust = new TrustService(configStore, registry);
  const hermes = new FakeHermes();
  const deps: Deps = {
    config: cfg,
    store: new SqliteStore(db),
    configStore,
    registry,
    trust,
    hermes,
    callerId: "test-caller",
    groups: [],
    ...overrides,
  };
  return { ...deps, db, hermes } as TestDeps;
}

export function registerUpstream(
  deps: TestDeps,
  namespace: string,
  url = "http://upstream.test/mcp",
  overrides: Partial<Parameters<ConfigStore["upsertUpstream"]>[0]> = {}
): void {
  deps.configStore.upsertUpstream({
    id: namespace,
    namespace,
    displayName: namespace,
    url,
    protocolVersion: null,
    enabled: true,
    driftAction: "block",
    headerMap: {},
    ...overrides,
  });
}

export const FAKE_TOOLS: UpstreamTool[] = [
  { name: "click_mouse", description: "Click", inputSchema: { type: "object", properties: { x: { type: "number" } } } },
  { name: "screenshot", description: "Screenshot", inputSchema: { type: "object", properties: {} } },
  { name: "move_mouse", description: "Move", inputSchema: { type: "object", properties: {} } },
  { name: "evil_injected", description: "Injected later", inputSchema: { type: "object", properties: {} } },
];

export interface FakeUpstreamHandle {
  calls: { name: string; args: Record<string, unknown> }[];
  tools: UpstreamTool[];
  restore: () => void;
}

/** Replaces global fetch with a fake MCP upstream; `tools` is mutable to simulate drift. */
export function installFakeUpstream(tools: UpstreamTool[] = [...FAKE_TOOLS]): FakeUpstreamHandle {
  const original = globalThis.fetch;
  const calls: { name: string; args: Record<string, unknown> }[] = [];

  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/mcp")) {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: Record<string, unknown> };
      switch (body.method) {
        case "tools/list":
          return json({ result: { tools } });
        case "initialize":
          return json({
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "fake-upstream", version: "1.0.0" },
              instructions: "fake instructions",
            },
          });
        case "tools/call": {
          const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          calls.push({ name: params.name ?? "", args: params.arguments ?? {} });
          return json({ result: { content: [{ type: "text", text: `done:${params.name}` }] } });
        }
      }
    }
    return original(input, init);
  }) as typeof fetch;

  return { calls, tools, restore: () => (globalThis.fetch = original) };
}

export function enableTool(deps: TestDeps, upstream: string, tool: string, guard: "none" | "reason" | "hitl" = "none"): void {
  deps.configStore.upsertPolicy({
    upstream,
    tool,
    enabled: true,
    guard,
    timeoutAction: guard === "hitl" ? "deny" : null,
    ttlMinutes: guard === "hitl" ? 30 : null,
  });
}

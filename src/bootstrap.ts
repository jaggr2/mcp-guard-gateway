import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "./config";
import { ConfigStore, type PolicyRow } from "./store/config";
import { SecretBox } from "./secrets";

/**
 * Seeds the configuration tables on first boot: upstreams, secrets, policies,
 * and default OpenCode project sandboxes (`rsearch`, `calendar-m365-google-sync`, `agent-memory`).
 * Never overwrites existing rows.
 */
export function bootstrap(config: GatewayConfig, db: Database.Database): void {
  const configStore = new ConfigStore(db);
  const secrets = new SecretBox(config.masterKey);

  if (config.bootstrapUpstream) {
    seedUpstream(
      configStore,
      config.bootstrapUpstream.namespace,
      config.bootstrapUpstream.namespace,
      config.bootstrapUpstream.url,
      "block",
      {}
    );
  }

  for (const up of config.seedUpstreams) {
    seedUpstream(
      configStore,
      up.namespace,
      up.displayName ?? up.namespace,
      up.url,
      up.driftAction ?? "block",
      up.headerMap ?? {}
    );
  }

  // Browser Broker upstreams (browser-host orchestrator facade) — always attempted,
  // seedUpstream() skips namespaces that already exist. URL comes from
  // BROWSER_ORCHESTRATOR_URL so runtimes without the `browser-host` DNS name
  // (podman→incus) can point at the IP instead. The facade requires its bearer
  // token (from the encrypted ORCHESTRATOR_TOKEN secret) — without it every call
  // 401s and trust pinning stays fail-closed, so self-heal the header on boot.
  seedUpstream(configStore, "playwright", "Playwright Browser", `${config.browserOrchestratorUrl}/mcp`, "block", {});
  seedUpstream(configStore, "devtools", "Chrome DevTools", `${config.browserOrchestratorUrl}/devtools`, "block", {});
  ensureBrowserUpstreamAuth(configStore, secrets);

  for (const [name, value] of Object.entries(config.seedSecrets)) {
    if (configStore.getSecret(name) === null) {
      configStore.setSecret(name, secrets.encrypt(value));
    }
  }

  // Seed default policies ONLY when none exist yet: seeding upserts, so re-running it
  // on every boot would stomp operator changes made in the UI (and revive stale rows).
  if (configStore.listPolicies().length === 0) {
    for (const p of config.seedPolicies) {
      configStore.upsertPolicy({
        upstream: p.namespace,
        tool: p.tool,
        enabled: p.enabled ?? true,
        guard: p.guard ?? "none",
        timeoutAction: p.timeoutAction ?? null,
        ttlMinutes: p.ttlMinutes ?? null,
      });
    }
  }

  // Browser Broker policies must exist on existing DBs too (the fresh-DB caveat in
  // docs/BROWSER_BROKER.md Part 11.3) — ensureBrowserPolicies() never overwrites rows.
  ensureBrowserPolicies(configStore);

  seedSetting(configStore, "hermes.bridgeUrl", config.hermesBridgeUrl);
  if (config.hermesConversationKey) {
    seedSetting(configStore, "hermes.conversationKey", config.hermesConversationKey);
  }
  if (config.hassUrl) {
    seedSetting(configStore, "hass.url", config.hassUrl);
  }

  // Seed default OpenCode sandboxes if none exist yet
  const defaultProjects = [
    {
      slug: "rsearch",
      displayName: "rsearch (Strands + Angular + CDK)",
      repoUrl: "https://github.com/jaggr2/rsearch",
      template: "fullstack" as const,
      lifecycleMode: "auto-stop" as const,
      allowedUpstreams: "github,aws,playwright,devtools",
    },
    {
      slug: "calendar-m365-google-sync",
      displayName: "Calendar M365 ↔ Google Sync",
      repoUrl: "https://github.com/jaggr2/calendar-m365-google-sync",
      template: "cdk" as const,
      lifecycleMode: "auto-stop" as const,
      allowedUpstreams: "github,aws,playwright,devtools",
    },
    {
      slug: "agent-memory",
      displayName: "Central Agent Memory & Skills",
      repoUrl: "https://github.com/jaggr2/agent-memory",
      template: "minimal" as const,
      lifecycleMode: "auto-stop" as const,
      allowedUpstreams: "github",
    },
  ];

  for (const dp of defaultProjects) {
    if (!configStore.getProject(dp.slug)) {
      configStore.upsertProject({
        slug: dp.slug,
        displayName: dp.displayName,
        repoUrl: dp.repoUrl,
        template: dp.template,
        lifecycleMode: dp.lifecycleMode,
        idleTimeoutMinutes: 120,
        dailyBudgetUsd: 5.0,
        monthlyBudgetUsd: 30.0,
        hourlyTokenCap: 500_000,
        dailyTokenCap: 2_500_000,
        awsRoleArn: null,
        awsDeployRoleArn: null,
        allowedUpstreams: dp.allowedUpstreams,
        tokenHash: null,
        status: "stopped",
        branch: "main",
        dirtyFiles: 0,
        lastActiveAt: null,
      });
    }
  }
}

function seedUpstream(
  configStore: ConfigStore,
  namespace: string,
  displayName: string,
  url: string,
  driftAction: "log" | "notify" | "block",
  headerMap: Record<string, string>
): void {
  if (configStore.getUpstream(namespace)) {
    return;
  }
  configStore.upsertUpstream({
    id: randomUUID(),
    namespace,
    displayName,
    url,
    protocolVersion: null,
    enabled: true,
    driftAction,
    headerMap,
  });
}

function seedSetting(configStore: ConfigStore, key: string, value: string): void {
  if (value && configStore.getSetting(key) === null) {
    configStore.setSetting(key, value);
  }
}

/**
 * Seeds the Browser Broker policy rows on every boot — but only when no policy
 * row exists yet for (upstream, tool), so operator changes made later in the UI
 * are never overwritten. Tool names are the full namespaced names `resolvePolicy`
 * matches on (see the `policies.tool` column comment).
 */
export function ensureBrowserPolicies(configStore: ConfigStore): void {
  const rows: Omit<PolicyRow, "updatedAt">[] = [
    { upstream: "playwright", tool: "*", enabled: true, guard: "reason", timeoutAction: null, ttlMinutes: null },
    // arbitrary JS execution — enable per-project deliberately
    { upstream: "playwright", tool: "playwright_browser_evaluate", enabled: false, guard: "none", timeoutAction: null, ttlMinutes: null },
    { upstream: "playwright", tool: "playwright_browser_file_upload", enabled: true, guard: "hitl", timeoutAction: "deny", ttlMinutes: 60 },
    { upstream: "playwright", tool: "playwright_browser_close", enabled: true, guard: "none", timeoutAction: null, ttlMinutes: null },
    { upstream: "devtools", tool: "*", enabled: true, guard: "reason", timeoutAction: null, ttlMinutes: null },
    { upstream: "devtools", tool: "devtools_evaluate_script", enabled: false, guard: "none", timeoutAction: null, ttlMinutes: null },
  ];
  for (const p of rows) {
    if (!configStore.getUpstream(p.upstream)) continue; // upstream deleted — skip (policies FK upstreams)
    if (configStore.getPolicy(p.upstream, p.tool)) continue;
    configStore.upsertPolicy(p);
  }
}

/**
 * Ensures the browser upstreams authenticate to the orchestrator facade: sets the
 * `Authorization` header on the playwright/devtools upstream rows from the encrypted
 * ORCHESTRATOR_TOKEN secret. Runs on every boot — the secret is the source of truth,
 * so token rotation self-heals on restart (without this every call 401s and trust
 * pinning stays fail-closed).
 */
export function ensureBrowserUpstreamAuth(configStore: ConfigStore, secrets: SecretBox): void {
  const ct = configStore.getSecret("ORCHESTRATOR_TOKEN");
  if (ct === null) return;
  let token: string;
  try {
    token = secrets.decrypt(ct);
  } catch {
    return;
  }
  if (!token) return;
  const headerMap: Record<string, string> = { Authorization: `Bearer ${token}` };
  for (const ns of ["playwright", "devtools"]) {
    const up = configStore.getUpstream(ns);
    if (!up) continue;
    configStore.upsertUpstream({ ...up, headerMap });
  }
}

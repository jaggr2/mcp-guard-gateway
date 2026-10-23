import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "./config";
import { ConfigStore } from "./store/config";
import { SecretBox } from "./secrets";

/**
 * Seeds the configuration tables on first boot: upstreams, secrets, policies,
 * default OpenCode project sandboxes (`rsearch`, `calendar-m365-google-sync`, `agent-memory`),
 * and the default 07:00 Morning Digest schedule.
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

  for (const [name, value] of Object.entries(config.seedSecrets)) {
    if (configStore.getSecret(name) === null) {
      configStore.setSecret(name, secrets.encrypt(value));
    }
  }

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
      allowedUpstreams: "github,aws,playwright",
    },
    {
      slug: "calendar-m365-google-sync",
      displayName: "Calendar M365 ↔ Google Sync",
      repoUrl: "https://github.com/jaggr2/calendar-m365-google-sync",
      template: "cdk" as const,
      lifecycleMode: "auto-stop" as const,
      allowedUpstreams: "github,aws,playwright",
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

  // Seed default 07:00 Morning Digest cron job (replaces Hermes morning-digest cron)
  if (configStore.listSchedules().length === 0) {
    configStore.upsertSchedule({
      id: randomUUID(),
      name: "morning-digest",
      cronExpr: "0 7 * * *",
      project: "system",
      model: "deepseek-v4-flash",
      prompt:
        "Produce a concise (<200 words) morning briefing covering: 1. Home Assistant status, 2. Homelab backup tiers, ZFS health & Incus instances, 3. OpenCode sandbox spend & any pending approvals.",
      allowedUpstreams: "*",
      deliveryTarget: "ha_notify",
      enabled: true,
    });
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

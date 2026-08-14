import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "./config";
import { ConfigStore } from "./store/config";
import { SecretBox } from "./secrets";

/**
 * Seeds the configuration tables on first boot: the bootstrap upstream (from
 * env), plus the full SEED_UPSTREAMS / SEED_SECRETS / SEED_POLICIES sets used to
 * register NanoKVM + UniFi and store their credentials encrypted at rest.
 * Never overwrites existing rows.
 */
export function bootstrap(config: GatewayConfig, db: Database.Database): void {
  const configStore = new ConfigStore(db);
  const secrets = new SecretBox(config.masterKey);

  if (config.bootstrapUpstream) {
    seedUpstream(configStore, config.bootstrapUpstream.namespace, config.bootstrapUpstream.namespace, config.bootstrapUpstream.url, "block", {});
  }

  for (const up of config.seedUpstreams) {
    seedUpstream(configStore, up.namespace, up.displayName ?? up.namespace, up.url, up.driftAction ?? "block", up.headerMap ?? {});
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

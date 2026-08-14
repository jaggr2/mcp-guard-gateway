export interface GatewayConfig {
  dbPath: string;
  host: string;
  port: number;
  /** Public base URL of the gateway (used in OAuth metadata + WWW-Authenticate). */
  publicUrl: string;
  /** Master key for encrypting secrets at rest (AES-256-GCM). */
  masterKey: string;
  /** Internal hermes-bridge endpoint (hermes mcp serve over HTTP). */
  hermesBridgeUrl: string;
  /** Hermes conversation target for approval cards (e.g. `telegram:<id>`). */
  hermesConversationKey: string | null;
  /** Trusted OIDC issuers for MCP Bearer auth (issuer -> {jwks, audience}). */
  issuers: IssuerConfig[];
  /** Authelia forward-auth identity headers set by the reverse proxy. */
  identityHeader: string;
  groupsHeader: string;
  adminGroups: string[];
  operatorGroups: string[];
  /** Optional bootstrap upstream seeded into the DB on first boot. */
  bootstrapUpstream: { namespace: string; url: string } | null;
  /** Seed data applied once on first boot (from SEED_UPSTREAMS/SEED_SECRETS/SEED_POLICIES). */
  seedUpstreams: SeedUpstream[];
  seedSecrets: Record<string, string>;
  seedPolicies: SeedPolicy[];
  /** MCP-Protocol-Version negotiated with the client, forwarded upstream. */
  protocolVersion: string | null;
}

export interface SeedUpstream {
  namespace: string;
  displayName?: string;
  url: string;
  driftAction?: "log" | "notify" | "block";
  headerMap?: Record<string, string>;
}

export interface SeedPolicy {
  namespace: string;
  tool: string;
  enabled?: boolean;
  guard?: "none" | "reason" | "hitl";
  timeoutAction?: "deny" | "approve" | null;
  ttlMinutes?: number | null;
}

export interface IssuerConfig {
  issuer: string;
  /** Optional overrides; resolved from the issuer's OIDC discovery document when absent. */
  jwksUrl?: string;
  userinfoUrl?: string;
  audience: string;
}

const DEFAULTS = {
  DB_PATH: "./data/gateway.db",
  HOST: "0.0.0.0",
  PORT: "8080",
  HERMES_BRIDGE_URL: "http://127.0.0.1:8643",
  CALLER_ID_HEADER: "Remote-Email",
  GROUPS_HEADER: "Remote-Groups",
  ADMIN_GROUPS: "admins",
  OPERATOR_GROUPS: "operators",
};

export function loadConfig(env: Record<string, string | undefined>, protocolVersion: string | null = null): GatewayConfig {
  const publicUrl = (env.PUBLIC_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

  const issuers: IssuerConfig[] = [];
  if (env.AUTHELIA_ISSUER) {
    const issuer = env.AUTHELIA_ISSUER.replace(/\/$/, "");
    issuers.push({
      issuer,
      jwksUrl: env.AUTHELIA_JWKS_URL || undefined,
      userinfoUrl: env.AUTHELIA_USERINFO_URL || undefined,
      audience: env.AUTHELIA_AUDIENCE ?? publicUrl,
    });
  }

  let bootstrapUpstream: { namespace: string; url: string } | null = null;
  if (env.UPSTREAM_URL) {
    bootstrapUpstream = {
      namespace: env.UPSTREAM_NAMESPACE ?? "nanokvm",
      url: env.UPSTREAM_URL,
    };
  }

  return {
    dbPath: env.DB_PATH ?? DEFAULTS.DB_PATH,
    host: env.HOST ?? DEFAULTS.HOST,
    port: Number(env.PORT ?? DEFAULTS.PORT),
    publicUrl,
    masterKey: env.SECRET_MASTER_KEY ?? "dev-master-key-change-me",
    hermesBridgeUrl: env.HERMES_BRIDGE_URL ?? DEFAULTS.HERMES_BRIDGE_URL,
    hermesConversationKey: env.HERMES_CONVERSATION_KEY ?? null,
    issuers,
    identityHeader: env.CALLER_ID_HEADER ?? DEFAULTS.CALLER_ID_HEADER,
    groupsHeader: env.GROUPS_HEADER ?? DEFAULTS.GROUPS_HEADER,
    adminGroups: splitCsv(env.ADMIN_GROUPS ?? DEFAULTS.ADMIN_GROUPS),
    operatorGroups: splitCsv(env.OPERATOR_GROUPS ?? DEFAULTS.OPERATOR_GROUPS),
    bootstrapUpstream,
    seedUpstreams: parseSeedUpstreams(env.SEED_UPSTREAMS),
    seedSecrets: parseJsonRecord(env.SEED_SECRETS),
    seedPolicies: parseSeedPolicies(env.SEED_POLICIES),
    protocolVersion,
  };
}

function parseJsonRecord(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      out[key] = String(val);
    }
    return out;
  } catch {
    return {};
  }
}

function parseSeedUpstreams(value: string | undefined): SeedUpstream[] {
  if (!value) return [];
  try {
    return JSON.parse(value) as SeedUpstream[];
  } catch {
    return [];
  }
}

function parseSeedPolicies(value: string | undefined): SeedPolicy[] {
  if (!value) return [];
  try {
    return JSON.parse(value) as SeedPolicy[];
  } catch {
    return [];
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

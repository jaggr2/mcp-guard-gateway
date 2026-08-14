import type Database from "better-sqlite3";

export type Guard = "none" | "reason" | "hitl";
export type DriftAction = "log" | "notify" | "block";
export type TrustState = "ok" | "drift" | "error";

export interface UpstreamRow {
  id: string;
  namespace: string;
  displayName: string;
  url: string;
  protocolVersion: string | null;
  enabled: boolean;
  driftAction: DriftAction;
  headerMap: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRow {
  upstream: string;
  tool: string; // '*' = upstream default
  enabled: boolean;
  guard: Guard;
  timeoutAction: "deny" | "approve" | null;
  ttlMinutes: number | null;
  updatedAt: string;
}

export interface TrustRow {
  upstream: string;
  pinnedHash: string;
  snapshot: string;
  pinnedAt: string;
  state: TrustState;
}

export interface ClientRow {
  id: string;
  name: string;
  secretHash: string | null;
  scopes: string;
  enabled: boolean;
  createdAt: string;
}

const nowIso = () => new Date().toISOString();

function parseHeaderMap(json: string | null): Record<string, string> {
  try {
    return json ? (JSON.parse(json) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Configuration/state repository over SQLite (admin API surface). */
export class ConfigStore {
  constructor(private db: Database.Database) {}

  // upstreams -----------------------------------------------------------------
  listUpstreams(): UpstreamRow[] {
    const rows = this.db.prepare("SELECT * FROM upstreams ORDER BY namespace").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      namespace: String(r.namespace),
      displayName: String(r.display_name),
      url: String(r.url),
      protocolVersion: r.protocol_version == null ? null : String(r.protocol_version),
      enabled: Number(r.enabled) === 1,
      driftAction: (r.drift_action as DriftAction) ?? "block",
      headerMap: parseHeaderMap(String(r.header_map)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  getUpstream(namespace: string): UpstreamRow | undefined {
    const row = this.db.prepare("SELECT * FROM upstreams WHERE namespace = ?").get(namespace) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      namespace: String(row.namespace),
      displayName: String(row.display_name),
      url: String(row.url),
      protocolVersion: row.protocol_version == null ? null : String(row.protocol_version),
      enabled: Number(row.enabled) === 1,
      driftAction: (row.drift_action as DriftAction) ?? "block",
      headerMap: parseHeaderMap(String(row.header_map)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  upsertUpstream(up: Omit<UpstreamRow, "createdAt" | "updatedAt">): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO upstreams (id, namespace, display_name, url, protocol_version, enabled, drift_action, header_map, created_at, updated_at)
         VALUES (@id, @namespace, @displayName, @url, @protocolVersion, @enabled, @driftAction, @headerMap, @ts, @ts)
         ON CONFLICT(namespace) DO UPDATE SET
           display_name = @displayName,
           url = @url,
           protocol_version = @protocolVersion,
           enabled = @enabled,
           drift_action = @driftAction,
           header_map = @headerMap,
           updated_at = @ts`
      )
      .run({
        id: up.id,
        namespace: up.namespace,
        displayName: up.displayName,
        url: up.url,
        protocolVersion: up.protocolVersion,
        enabled: up.enabled ? 1 : 0,
        driftAction: up.driftAction,
        headerMap: JSON.stringify(up.headerMap),
        ts,
      });
  }

  deleteUpstream(namespace: string): void {
    this.db.prepare("DELETE FROM upstreams WHERE namespace = ?").run(namespace);
  }

  // policies ------------------------------------------------------------------
  listPolicies(upstream?: string): PolicyRow[] {
    const rows = (
      upstream
        ? this.db.prepare("SELECT * FROM policies WHERE upstream = ? ORDER BY tool").all(upstream)
        : this.db.prepare("SELECT * FROM policies ORDER BY upstream, tool").all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      upstream: String(r.upstream),
      tool: String(r.tool),
      enabled: Number(r.enabled) === 1,
      guard: (r.guard as Guard) ?? "none",
      timeoutAction: (r.timeout_action as "deny" | "approve" | null) ?? null,
      ttlMinutes: r.ttl_minutes == null ? null : Number(r.ttl_minutes),
      updatedAt: String(r.updated_at),
    }));
  }

  getPolicy(upstream: string, tool: string): PolicyRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM policies WHERE upstream = ? AND tool = ?")
      .get(upstream, tool) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      upstream: String(row.upstream),
      tool: String(row.tool),
      enabled: Number(row.enabled) === 1,
      guard: (row.guard as Guard) ?? "none",
      timeoutAction: (row.timeout_action as "deny" | "approve" | null) ?? null,
      ttlMinutes: row.ttl_minutes == null ? null : Number(row.ttl_minutes),
      updatedAt: String(row.updated_at),
    };
  }

  upsertPolicy(p: Omit<PolicyRow, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO policies (upstream, tool, enabled, guard, timeout_action, ttl_minutes, updated_at)
         VALUES (@upstream, @tool, @enabled, @guard, @timeoutAction, @ttlMinutes, @ts)
         ON CONFLICT(upstream, tool) DO UPDATE SET
           enabled = @enabled, guard = @guard,
           timeout_action = @timeoutAction, ttl_minutes = @ttlMinutes, updated_at = @ts`
      )
      .run({
        upstream: p.upstream,
        tool: p.tool,
        enabled: p.enabled ? 1 : 0,
        guard: p.guard,
        timeoutAction: p.timeoutAction,
        ttlMinutes: p.ttlMinutes,
        ts: nowIso(),
      });
  }

  deletePolicy(upstream: string, tool: string): void {
    this.db.prepare("DELETE FROM policies WHERE upstream = ? AND tool = ?").run(upstream, tool);
  }

  // trust ---------------------------------------------------------------------
  getTrust(upstream: string): TrustRow | undefined {
    const row = this.db.prepare("SELECT * FROM trust WHERE upstream = ?").get(upstream) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      upstream: String(row.upstream),
      pinnedHash: String(row.pinned_hash),
      snapshot: String(row.snapshot),
      pinnedAt: String(row.pinned_at),
      state: (row.state as TrustState) ?? "ok",
    };
  }

  upsertTrust(t: TrustRow): void {
    this.db
      .prepare(
        `INSERT INTO trust (upstream, pinned_hash, snapshot, pinned_at, state)
         VALUES (@upstream, @pinnedHash, @snapshot, @pinnedAt, @state)
         ON CONFLICT(upstream) DO UPDATE SET
           pinned_hash = @pinnedHash, snapshot = @snapshot, pinned_at = @pinnedAt, state = @state`
      )
      .run(t);
  }

  // settings ------------------------------------------------------------------
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  listSettings(): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM settings ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
  }

  // clients -------------------------------------------------------------------
  listClients(): ClientRow[] {
    const rows = this.db.prepare("SELECT * FROM clients ORDER BY created_at").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      secretHash: r.secret_hash == null ? null : String(r.secret_hash),
      scopes: String(r.scopes),
      enabled: Number(r.enabled) === 1,
      createdAt: String(r.created_at),
    }));
  }

  getClient(id: string): ClientRow | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      name: String(row.name),
      secretHash: row.secret_hash == null ? null : String(row.secret_hash),
      scopes: String(row.scopes),
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
    };
  }

  upsertClient(c: Omit<ClientRow, "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO clients (id, name, secret_hash, scopes, enabled, created_at)
         VALUES (@id, @name, @secretHash, @scopes, @enabled, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, secret_hash = @secretHash, scopes = @scopes, enabled = @enabled`
      )
      .run({
        id: c.id,
        name: c.name,
        secretHash: c.secretHash,
        scopes: c.scopes,
        enabled: c.enabled ? 1 : 0,
        createdAt: nowIso(),
      });
  }

  deleteClient(id: string): void {
    this.db.prepare("DELETE FROM clients WHERE id = ?").run(id);
  }

  // secrets -------------------------------------------------------------------
  getSecret(name: string): string | null {
    const row = this.db.prepare("SELECT value_ciphertext FROM secrets WHERE name = ?").get(name) as
      | { value_ciphertext: string }
      | undefined;
    return row?.value_ciphertext ?? null;
  }

  setSecret(name: string, ciphertext: string): void {
    this.db
      .prepare(
        `INSERT INTO secrets (name, value_ciphertext, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value_ciphertext = excluded.value_ciphertext`
      )
      .run(name, ciphertext, nowIso());
  }

  deleteSecret(name: string): void {
    this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
  }
}

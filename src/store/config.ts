import type Database from "better-sqlite3";

export type Guard = "none" | "reason" | "hitl";
export type DriftAction = "log" | "notify" | "block";
export type TrustState = "ok" | "drift" | "error";
export type LifecycleMode = "auto-stop" | "always-on";
export type ProjectTemplate = "import" | "fullstack" | "cdk" | "minimal";

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

export interface ProjectRow {
  slug: string;
  displayName: string;
  repoUrl: string;
  template: ProjectTemplate;
  lifecycleMode: LifecycleMode;
  idleTimeoutMinutes: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  hourlyTokenCap: number;
  dailyTokenCap: number;
  awsRoleArn: string | null;
  awsDeployRoleArn: string | null;
  allowedUpstreams: string;
  /** Browser Broker: CSV of allowed navigation domains (`*` = any, `''` = any non-private). */
  browserAllowedDomains: string;
  /** Browser Broker: CSV of private hostnames/IPs navigation may still reach (exact match, port suffix allowed). */
  browserInternalTargets: string;
  tokenHash: string | null;
  status: string;
  branch: string;
  dirtyFiles: number;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmUsageRecord {
  project: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd: number;
  latencyMs: number;
  status: string;
  error?: string | null;
}

export interface ProjectUsageSummary {
  project: string;
  costTodayUsd: number;
  costMonthUsd: number;
  tokensHour: number;
  tokensToday: number;
  opencodeGoTokensToday: number;
  requestsToday: number;
}

export interface LearningRow {
  id: number;
  ts: string;
  sourceProject: string;
  kind: "gotcha" | "memory" | "skill";
  targetPath: string;
  title: string;
  content: string;
  mode: "append" | "replace";
  rationale: string | null;
  status: string;
  commitRef: string | null;
}

export interface ScheduleRow {
  id: string;
  name: string;
  cronExpr: string;
  project: string;
  model: string;
  prompt: string;
  allowedUpstreams: string;
  deliveryTarget: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastOutput: string | null;
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

function mapProjectRow(r: Record<string, unknown>): ProjectRow {
  return {
    slug: String(r.slug),
    displayName: String(r.display_name),
    repoUrl: String(r.repo_url),
    template: (r.template as ProjectTemplate) ?? "import",
    lifecycleMode: (r.lifecycle_mode as LifecycleMode) ?? "auto-stop",
    idleTimeoutMinutes: Number(r.idle_timeout_minutes ?? 120),
    dailyBudgetUsd: Number(r.daily_budget_usd ?? 5.0),
    monthlyBudgetUsd: Number(r.monthly_budget_usd ?? 30.0),
    hourlyTokenCap: Number(r.hourly_token_cap ?? 500000),
    dailyTokenCap: Number(r.daily_token_cap ?? 2500000),
    awsRoleArn: r.aws_role_arn == null ? null : String(r.aws_role_arn),
    awsDeployRoleArn: r.aws_deploy_role_arn == null ? null : String(r.aws_deploy_role_arn),
    allowedUpstreams: String(r.allowed_upstreams ?? "*"),
    browserAllowedDomains: String(r.browser_allowed_domains ?? ""),
    browserInternalTargets: String(r.browser_internal_targets ?? ""),
    tokenHash: r.token_hash == null ? null : String(r.token_hash),
    status: String(r.status ?? "stopped"),
    branch: String(r.branch ?? "main"),
    dirtyFiles: Number(r.dirty_files ?? 0),
    lastActiveAt: r.last_active_at == null ? null : String(r.last_active_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
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

  listSecretCiphertexts(): string[] {
    const rows = this.db.prepare("SELECT value_ciphertext FROM secrets").all() as {
      value_ciphertext: string;
    }[];
    return rows.map((r) => r.value_ciphertext);
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

  // projects (OpenCode sandboxes) ---------------------------------------------
  listProjects(): ProjectRow[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY slug").all() as Record<
      string,
      unknown
    >[];
    return rows.map(mapProjectRow);
  }

  getProject(slug: string): ProjectRow | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProjectRow(row) : undefined;
  }

  getProjectByTokenHash(tokenHash: string): ProjectRow | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE token_hash = ?").get(tokenHash) as
      | Record<string, unknown>
      | undefined;
    return row ? mapProjectRow(row) : undefined;
  }

  upsertProject(
    p: Omit<ProjectRow, "createdAt" | "updatedAt" | "browserAllowedDomains" | "browserInternalTargets"> &
      Partial<Pick<ProjectRow, "browserAllowedDomains" | "browserInternalTargets">>
  ): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (
           slug, display_name, repo_url, template, lifecycle_mode, idle_timeout_minutes,
           daily_budget_usd, monthly_budget_usd, hourly_token_cap, daily_token_cap,
           aws_role_arn, aws_deploy_role_arn, allowed_upstreams,
           browser_allowed_domains, browser_internal_targets, token_hash,
           status, branch, dirty_files, last_active_at, created_at, updated_at
         ) VALUES (
           @slug, @displayName, @repoUrl, @template, @lifecycleMode, @idleTimeoutMinutes,
           @dailyBudgetUsd, @monthlyBudgetUsd, @hourlyTokenCap, @dailyTokenCap,
           @awsRoleArn, @awsDeployRoleArn, @allowedUpstreams,
           @browserAllowedDomains, @browserInternalTargets, @tokenHash,
           @status, @branch, @dirtyFiles, @lastActiveAt, @ts, @ts
         )
         ON CONFLICT(slug) DO UPDATE SET
           display_name = @displayName,
           repo_url = @repoUrl,
           template = @template,
           lifecycle_mode = @lifecycleMode,
           idle_timeout_minutes = @idleTimeoutMinutes,
           daily_budget_usd = @dailyBudgetUsd,
           monthly_budget_usd = @monthlyBudgetUsd,
           hourly_token_cap = @hourlyTokenCap,
           daily_token_cap = @dailyTokenCap,
           aws_role_arn = @awsRoleArn,
           aws_deploy_role_arn = @awsDeployRoleArn,
           allowed_upstreams = @allowedUpstreams,
           browser_allowed_domains = @browserAllowedDomains,
           browser_internal_targets = @browserInternalTargets,
           token_hash = COALESCE(@tokenHash, projects.token_hash),
           status = @status,
           branch = @branch,
           dirty_files = @dirtyFiles,
           last_active_at = COALESCE(@lastActiveAt, projects.last_active_at),
           updated_at = @ts`
      )
      .run({
        ...p,
        browserAllowedDomains: p.browserAllowedDomains ?? "",
        browserInternalTargets: p.browserInternalTargets ?? "",
        ts,
      });
  }

  touchProjectActivity(slug: string, status?: string): void {
    const ts = nowIso();
    if (status) {
      this.db
        .prepare("UPDATE projects SET last_active_at = ?, status = ?, updated_at = ? WHERE slug = ?")
        .run(ts, status, ts, slug);
    } else {
      this.db
        .prepare("UPDATE projects SET last_active_at = ?, updated_at = ? WHERE slug = ?")
        .run(ts, ts, slug);
    }
  }

  deleteProject(slug: string): void {
    this.db.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
  }

  // LLM usage & cost ledger ---------------------------------------------------
  recordLlmUsage(rec: LlmUsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage (
           ts, project, provider, model, input_tokens, output_tokens,
           cached_tokens, reasoning_tokens, cost_usd, latency_ms, status, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nowIso(),
        rec.project,
        rec.provider,
        rec.model,
        rec.inputTokens,
        rec.outputTokens,
        rec.cachedTokens ?? 0,
        rec.reasoningTokens ?? 0,
        rec.costUsd,
        rec.latencyMs,
        rec.status,
        rec.error ?? null
      );
  }

  getProjectUsageSummary(project: string, now = new Date()): ProjectUsageSummary {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const hourStart = new Date(now.getTime() - 3600_000).toISOString();

    const todayRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS cost_today,
           COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens), 0) AS tokens_today,
           COALESCE(SUM(CASE WHEN provider = 'opencode-go' THEN input_tokens + output_tokens + reasoning_tokens ELSE 0 END), 0) AS oc_tokens_today,
           COUNT(*) AS reqs_today
         FROM llm_usage WHERE project = ? AND ts >= ?`
      )
      .get(project, dayStart) as Record<string, unknown>;

    const monthRow = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost_month FROM llm_usage WHERE project = ? AND ts >= ?")
      .get(project, monthStart) as Record<string, unknown>;

    const hourRow = this.db
      .prepare(
        "SELECT COALESCE(SUM(input_tokens + output_tokens + reasoning_tokens), 0) AS tokens_hour FROM llm_usage WHERE project = ? AND ts >= ?"
      )
      .get(project, hourStart) as Record<string, unknown>;

    return {
      project,
      costTodayUsd: Number(todayRow?.cost_today ?? 0),
      costMonthUsd: Number(monthRow?.cost_month ?? 0),
      tokensHour: Number(hourRow?.tokens_hour ?? 0),
      tokensToday: Number(todayRow?.tokens_today ?? 0),
      opencodeGoTokensToday: Number(todayRow?.oc_tokens_today ?? 0),
      requestsToday: Number(todayRow?.reqs_today ?? 0),
    };
  }

  getGlobalUsageSummary(now = new Date()): {
    costTodayUsd: number;
    costMonthUsd: number;
    opencodeGoTokensToday: number;
    mcpCallsToday: number;
  } {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const todayRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS cost_today,
           COALESCE(SUM(CASE WHEN provider = 'opencode-go' THEN input_tokens + output_tokens + reasoning_tokens ELSE 0 END), 0) AS oc_tokens_today
         FROM llm_usage WHERE ts >= ?`
      )
      .get(dayStart) as Record<string, unknown>;

    const monthRow = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost_month FROM llm_usage WHERE ts >= ?")
      .get(monthStart) as Record<string, unknown>;

    const mcpRow = this.db
      .prepare("SELECT COUNT(*) AS mcp_calls FROM audit WHERE ts >= ?")
      .get(dayStart) as Record<string, unknown>;

    return {
      costTodayUsd: Number(todayRow?.cost_today ?? 0),
      costMonthUsd: Number(monthRow?.cost_month ?? 0),
      opencodeGoTokensToday: Number(todayRow?.oc_tokens_today ?? 0),
      mcpCallsToday: Number(mcpRow?.mcp_calls ?? 0),
    };
  }

  // central learnings (jaggr2/agent-memory) -----------------------------------
  listLearnings(limit = 50): LearningRow[] {
    const rows = this.db
      .prepare("SELECT * FROM learnings ORDER BY id DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: String(r.ts),
      sourceProject: String(r.source_project),
      kind: (r.kind as "gotcha" | "memory" | "skill") ?? "gotcha",
      targetPath: String(r.target_path),
      title: String(r.title),
      content: String(r.content),
      mode: (r.mode as "append" | "replace") ?? "append",
      rationale: r.rationale == null ? null : String(r.rationale),
      status: String(r.status),
      commitRef: r.commit_ref == null ? null : String(r.commit_ref),
    }));
  }

  insertLearning(l: Omit<LearningRow, "id" | "ts">): LearningRow {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO learnings (ts, source_project, kind, target_path, title, content, mode, rationale, status, commit_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ts, l.sourceProject, l.kind, l.targetPath, l.title, l.content, l.mode, l.rationale, l.status, l.commitRef);
    return { id: Number(info.lastInsertRowid), ts, ...l };
  }

  // schedules (Warden Cron) ---------------------------------------------------
  listSchedules(): ScheduleRow[] {
    const rows = this.db.prepare("SELECT * FROM schedules ORDER BY name").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      cronExpr: String(r.cron_expr),
      project: String(r.project),
      model: String(r.model),
      prompt: String(r.prompt),
      allowedUpstreams: String(r.allowed_upstreams),
      deliveryTarget: String(r.delivery_target),
      enabled: Number(r.enabled) === 1,
      lastRunAt: r.last_run_at == null ? null : String(r.last_run_at),
      lastStatus: r.last_status == null ? null : String(r.last_status),
      lastOutput: r.last_output == null ? null : String(r.last_output),
      createdAt: String(r.created_at),
    }));
  }

  upsertSchedule(s: Omit<ScheduleRow, "createdAt" | "lastRunAt" | "lastStatus" | "lastOutput"> & {
    lastRunAt?: string | null;
    lastStatus?: string | null;
    lastOutput?: string | null;
  }): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, cron_expr, project, model, prompt, allowed_upstreams, delivery_target, enabled, last_run_at, last_status, last_output, created_at)
         VALUES (@id, @name, @cronExpr, @project, @model, @prompt, @allowedUpstreams, @deliveryTarget, @enabled, @lastRunAt, @lastStatus, @lastOutput, @ts)
         ON CONFLICT(name) DO UPDATE SET
           cron_expr = @cronExpr,
           project = @project,
           model = @model,
           prompt = @prompt,
           allowed_upstreams = @allowedUpstreams,
           delivery_target = @deliveryTarget,
           enabled = @enabled,
           last_run_at = COALESCE(@lastRunAt, schedules.last_run_at),
           last_status = COALESCE(@lastStatus, schedules.last_status),
           last_output = COALESCE(@lastOutput, schedules.last_output)`
      )
      .run({
        ...s,
        enabled: s.enabled ? 1 : 0,
        lastRunAt: s.lastRunAt ?? null,
        lastStatus: s.lastStatus ?? null,
        lastOutput: s.lastOutput ?? null,
        ts,
      });
  }

  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ? OR name = ?").run(id, id);
  }
}

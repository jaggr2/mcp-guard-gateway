import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "../config";
import type { HermesBridge } from "../hermes/bridge";
import { NoopHermesBridge } from "../hermes/bridge";
import { buildDeps } from "../mcp";
import {
  ConfigStore,
  type LifecycleMode,
  type ProjectTemplate,
} from "../store/config";
import { SecretBox } from "../secrets";
import { authenticateAdmin, isAdmin, isOperator, type AuthContext } from "../auth/middleware";
import { snapshotToHash, type TrustSnapshot } from "../trust/pin";
import { processLearningProposal } from "../memory/learning";
import { runSandboxCtl } from "../sandboxes/proxy";

type AppEnv = { Variables: { auth: AuthContext } };
type App = Hono<AppEnv>;

function requireAuth(
  config: GatewayConfig,
  check: (ctx: AuthContext, config: GatewayConfig) => boolean
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = authenticateAdmin(c.req.raw, config);
    if (!ctx) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!check(ctx, config)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    c.set("auth", ctx);
    await next();
  };
}

export function registerApi(
  app: Hono,
  config: GatewayConfig,
  db: Database.Database,
  notifier: HermesBridge = new NoopHermesBridge()
): void {
  const configStore = new ConfigStore(db);
  const secrets = new SecretBox(config.masterKey);
  const api: App = new Hono();

  const anyAuth = requireAuth(config, () => true);
  const admin = requireAuth(config, isAdmin);
  const operator = requireAuth(config, isOperator);

  // Local unauthenticated summary endpoint consumed by host ha-sweep.sh (127.0.0.1)
  api.get("/ha-summary", async (c) => {
    const baseDeps = buildDeps(config, db, "system", [], notifier);
    const globalUsage = configStore.getGlobalUsageSummary();
    const pendingRows = await baseDeps.store.listApprovals("pending");
    const projects = configStore.listProjects();

    let budgetAlert = false;
    let budgetAlertReason = "";
    const sandboxes = projects.map((p) => {
      const u = configStore.getProjectUsageSummary(p.slug);
      if (p.dailyBudgetUsd > 0 && u.costTodayUsd >= p.dailyBudgetUsd * 0.8 && !budgetAlert) {
        budgetAlert = true;
        budgetAlertReason = `${p.slug} at $${u.costTodayUsd.toFixed(2)} / $${p.dailyBudgetUsd.toFixed(2)} daily budget`;
      }
      return {
        slug: p.slug,
        display_name: p.displayName,
        status: p.status,
        running: p.status === "running",
        branch: p.branch,
        dirty_files: p.dirtyFiles,
        lifecycle: p.lifecycleMode,
        url: `https://${p.slug}.oc.jaggi.xyz`,
        repo_url: p.repoUrl,
        cost_today: u.costTodayUsd,
        cost_month: u.costMonthUsd,
        tokens_today: u.tokensToday,
        last_active_at: p.lastActiveAt,
      };
    });

    const digestSchedule = configStore.listSchedules().find((s) => s.name === "morning-digest");

    return c.json({
      online: true,
      sandboxes,
      llm_cost_today: globalUsage.costTodayUsd,
      llm_cost_month: globalUsage.costMonthUsd,
      opencode_go_tokens_today: globalUsage.opencodeGoTokensToday,
      mcp_calls_today: globalUsage.mcpCallsToday,
      pending_approvals_count: pendingRows.length,
      pending_approvals: pendingRows.map((r) => ({
        id: r.id,
        tool: r.tool,
        reason: r.reason,
        created_at: r.created_at,
      })),
      morning_digest: digestSchedule?.lastOutput ?? "No morning briefing generated yet.",
      budget_alert: budgetAlert,
      budget_alert_reason: budgetAlertReason,
    });
  });

  // Home Assistant button / actionable notification callback for HITL approvals
  api.post("/approvals/latest-decision", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      decision?: "approved" | "denied" | "approve" | "deny";
      approvalId?: string;
      action?: string;
      decidedBy?: string;
    } | null;
    const baseDeps = buildDeps(config, db, "homeassistant", [], notifier);

    let approvalId = body?.approvalId;
    let status: "approved" | "denied" | null = null;

    if (typeof body?.action === "string") {
      if (body.action.startsWith("WARDEN_APPROVE_")) {
        approvalId = body.action.slice("WARDEN_APPROVE_".length);
        status = "approved";
      } else if (body.action.startsWith("WARDEN_DENY_")) {
        approvalId = body.action.slice("WARDEN_DENY_".length);
        status = "denied";
      }
    }
    if (!status && body?.decision) {
      status = body.decision === "approve" || body.decision === "approved" ? "approved" : "denied";
    }
    if (!status) {
      return c.json({ error: "decision or action is required" }, 400);
    }

    if (!approvalId) {
      const pending = await baseDeps.store.listApprovals("pending");
      if (pending.length === 0) {
        return c.json({ ok: false, error: "no pending approvals" }, 404);
      }
      approvalId = pending[0].id;
    }

    await baseDeps.store.setApprovalStatus(approvalId, status, {
      hermesUserId: body?.decidedBy ?? "homeassistant",
    });
    return c.json({ ok: true, approval_id: approvalId, status });
  });

  api.get("/status", anyAuth, (c) => {
    const upstreams = configStore.listUpstreams().map((u) => {
      const trust = configStore.getTrust(u.namespace);
      return {
        namespace: u.namespace,
        displayName: u.displayName,
        enabled: u.enabled,
        trust: trust?.state ?? "unpinned",
      };
    });
    const globalUsage = configStore.getGlobalUsageSummary();
    const sandboxes = configStore.listProjects().map((p) => {
      const u = configStore.getProjectUsageSummary(p.slug);
      return {
        slug: p.slug,
        displayName: p.displayName,
        status: p.status,
        lifecycleMode: p.lifecycleMode,
        costTodayUsd: u.costTodayUsd,
        dailyBudgetUsd: p.dailyBudgetUsd,
      };
    });
    return c.json({
      publicUrl: config.publicUrl,
      issuers: config.issuers.map((i) => i.issuer),
      upstreams,
      sandboxes,
      globalUsage,
    });
  });

  // sandboxes (OpenCode project instances) ------------------------------------
  api.get("/sandboxes", anyAuth, (c) => {
    const rows = configStore.listProjects().map((p) => {
      const usage = configStore.getProjectUsageSummary(p.slug);
      return {
        slug: p.slug,
        displayName: p.displayName,
        repoUrl: p.repoUrl,
        url: `https://${p.slug}.oc.jaggi.xyz`,
        template: p.template,
        lifecycleMode: p.lifecycleMode,
        idleTimeoutMinutes: p.idleTimeoutMinutes,
        dailyBudgetUsd: p.dailyBudgetUsd,
        monthlyBudgetUsd: p.monthlyBudgetUsd,
        hourlyTokenCap: p.hourlyTokenCap,
        dailyTokenCap: p.dailyTokenCap,
        awsRoleArn: p.awsRoleArn,
        awsDeployRoleArn: p.awsDeployRoleArn,
        allowedUpstreams: p.allowedUpstreams,
        status: p.status,
        branch: p.branch,
        dirtyFiles: p.dirtyFiles,
        lastActiveAt: p.lastActiveAt,
        usage,
      };
    });
    return c.json({ sandboxes: rows });
  });

  api.post("/sandboxes", admin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.slug !== "string") {
      return c.json({ error: "slug is required" }, 400);
    }
    const slug = body.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(slug)) {
      return c.json({ error: "slug must be 2-50 chars [a-z0-9-]" }, 400);
    }
    const template: ProjectTemplate =
      body.template === "fullstack" || body.template === "cdk" || body.template === "minimal"
        ? body.template
        : "import";
    const lifecycleMode: LifecycleMode =
      body.lifecycleMode === "always-on" ? "always-on" : "auto-stop";

    const rawToken = `oc_${slug}_${randomBytes(24).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    configStore.upsertProject({
      slug,
      displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : slug,
      repoUrl: typeof body.repoUrl === "string" && body.repoUrl.trim() ? body.repoUrl.trim() : `https://github.com/jaggr2/${slug}`,
      template,
      lifecycleMode,
      idleTimeoutMinutes: typeof body.idleTimeoutMinutes === "number" ? body.idleTimeoutMinutes : 120,
      dailyBudgetUsd: typeof body.dailyBudgetUsd === "number" ? body.dailyBudgetUsd : 5.0,
      monthlyBudgetUsd: typeof body.monthlyBudgetUsd === "number" ? body.monthlyBudgetUsd : 30.0,
      hourlyTokenCap: typeof body.hourlyTokenCap === "number" ? body.hourlyTokenCap : 500_000,
      dailyTokenCap: typeof body.dailyTokenCap === "number" ? body.dailyTokenCap : 2_500_000,
      awsRoleArn: typeof body.awsRoleArn === "string" && body.awsRoleArn.trim() ? body.awsRoleArn.trim() : null,
      awsDeployRoleArn: typeof body.awsDeployRoleArn === "string" && body.awsDeployRoleArn.trim() ? body.awsDeployRoleArn.trim() : null,
      allowedUpstreams: typeof body.allowedUpstreams === "string" ? body.allowedUpstreams : "*",
      tokenHash,
      status: "running",
      branch: "main",
      dirtyFiles: 0,
      lastActiveAt: new Date().toISOString(),
    });

    // Trigger host provisioning asynchronously via sandbox-ctl.py
    void runSandboxCtl(config.sandboxCtlScript, [
      "provision",
      slug,
      "--template",
      template,
      "--token",
      rawToken,
    ]);

    void notifier.notify(`🚀 Provisioned OpenCode sandbox '${slug}' (https://${slug}.oc.jaggi.xyz)`);
    return c.json({
      ok: true,
      slug,
      url: `https://${slug}.oc.jaggi.xyz`,
      repoUrl: `https://github.com/jaggr2/${slug}`,
      sandboxToken: rawToken,
    });
  });

  api.put("/sandboxes/:slug", admin, async (c) => {
    const slug = c.req.param("slug");
    const existing = configStore.getProject(slug);
    if (!existing) return c.json({ error: "not found" }, 404);
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

    configStore.upsertProject({
      ...existing,
      displayName: typeof body.displayName === "string" ? body.displayName : existing.displayName,
      lifecycleMode: body.lifecycleMode === "always-on" || body.lifecycleMode === "auto-stop" ? body.lifecycleMode : existing.lifecycleMode,
      idleTimeoutMinutes: typeof body.idleTimeoutMinutes === "number" ? body.idleTimeoutMinutes : existing.idleTimeoutMinutes,
      dailyBudgetUsd: typeof body.dailyBudgetUsd === "number" ? body.dailyBudgetUsd : existing.dailyBudgetUsd,
      monthlyBudgetUsd: typeof body.monthlyBudgetUsd === "number" ? body.monthlyBudgetUsd : existing.monthlyBudgetUsd,
      hourlyTokenCap: typeof body.hourlyTokenCap === "number" ? body.hourlyTokenCap : existing.hourlyTokenCap,
      dailyTokenCap: typeof body.dailyTokenCap === "number" ? body.dailyTokenCap : existing.dailyTokenCap,
      awsRoleArn: typeof body.awsRoleArn === "string" ? body.awsRoleArn || null : existing.awsRoleArn,
      awsDeployRoleArn: typeof body.awsDeployRoleArn === "string" ? body.awsDeployRoleArn || null : existing.awsDeployRoleArn,
      allowedUpstreams: typeof body.allowedUpstreams === "string" ? body.allowedUpstreams : existing.allowedUpstreams,
    });
    return c.json({ ok: true, slug });
  });

  api.post("/sandboxes/:slug/:action", operator, async (c) => {
    const slug = c.req.param("slug");
    const action = c.req.param("action");
    const existing = configStore.getProject(slug);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (!["start", "stop", "restart", "snapshot"].includes(action)) {
      return c.json({ error: "invalid action" }, 400);
    }

    const ctlRes = await runSandboxCtl(config.sandboxCtlScript, [action, slug]);
    const nextStatus = action === "stop" ? "stopped" : "running";
    if (action !== "snapshot") {
      configStore.upsertProject({
        ...existing,
        status: nextStatus,
        lastActiveAt: action === "start" || action === "restart" ? new Date().toISOString() : existing.lastActiveAt,
      });
    }
    return c.json({ ok: true, slug, action, status: nextStatus, host: ctlRes });
  });

  api.delete("/sandboxes/:slug", admin, async (c) => {
    const slug = c.req.param("slug");
    await runSandboxCtl(config.sandboxCtlScript, ["destroy", slug]);
    configStore.deleteProject(slug);
    return c.json({ ok: true });
  });

  // LLM cost & quota usage ----------------------------------------------------
  api.get("/llm/usage", anyAuth, (c) => {
    const globalSummary = configStore.getGlobalUsageSummary();
    const perProject = configStore.listProjects().map((p) => ({
      slug: p.slug,
      displayName: p.displayName,
      dailyBudgetUsd: p.dailyBudgetUsd,
      monthlyBudgetUsd: p.monthlyBudgetUsd,
      hourlyTokenCap: p.hourlyTokenCap,
      dailyTokenCap: p.dailyTokenCap,
      ...configStore.getProjectUsageSummary(p.slug),
    }));
    const recentRows = db
      .prepare("SELECT * FROM llm_usage ORDER BY id DESC LIMIT 100")
      .all();
    return c.json({ global: globalSummary, projects: perProject, recent: recentRows });
  });

  // Central Memory (`jaggr2/agent-memory`) & Learnings ------------------------
  api.get("/learnings", anyAuth, (c) => {
    return c.json({ learnings: configStore.listLearnings(100) });
  });

  api.post("/learnings", operator, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.targetPath !== "string" || typeof body.title !== "string" || typeof body.content !== "string") {
      return c.json({ error: "targetPath, title, and content are required" }, 400);
    }
    const res = processLearningProposal(configStore, config.agentMemoryDir, {
      sourceProject: typeof body.sourceProject === "string" ? body.sourceProject : "warden-ui",
      kind: body.kind === "skill" || body.kind === "memory" ? body.kind : "gotcha",
      targetPath: body.targetPath,
      title: body.title,
      content: body.content,
      mode: body.mode === "replace" ? "replace" : "append",
      rationale: typeof body.rationale === "string" ? body.rationale : undefined,
    });
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json({ ok: true, learning: res.learning });
  });

  // Schedules (Warden Cron) ---------------------------------------------------
  api.get("/schedules", anyAuth, (c) => {
    return c.json({ schedules: configStore.listSchedules() });
  });

  api.post("/schedules", admin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string" || typeof body.cronExpr !== "string" || typeof body.prompt !== "string") {
      return c.json({ error: "name, cronExpr, and prompt are required" }, 400);
    }
    configStore.upsertSchedule({
      id: randomUUID(),
      name: body.name.trim(),
      cronExpr: body.cronExpr.trim(),
      project: typeof body.project === "string" ? body.project : "system",
      model: typeof body.model === "string" ? body.model : "deepseek-v4-flash",
      prompt: body.prompt,
      allowedUpstreams: typeof body.allowedUpstreams === "string" ? body.allowedUpstreams : "*",
      deliveryTarget: typeof body.deliveryTarget === "string" ? body.deliveryTarget : "ha_notify",
      enabled: body.enabled !== false,
    });
    return c.json({ ok: true });
  });

  api.delete("/schedules/:id", admin, (c) => {
    configStore.deleteSchedule(c.req.param("id"));
    return c.json({ ok: true });
  });

  // upstreams -----------------------------------------------------------------
  api.get("/upstreams", anyAuth, (c) => {
    const rows = configStore.listUpstreams().map((u) => {
      const trust = configStore.getTrust(u.namespace);
      const toolCount = trust ? (JSON.parse(trust.snapshot) as TrustSnapshot).tools.length : 0;
      return {
        namespace: u.namespace,
        displayName: u.displayName,
        url: u.url,
        protocolVersion: u.protocolVersion,
        enabled: u.enabled,
        driftAction: u.driftAction,
        headerMap: u.headerMap,
        trust: trust ? { state: trust.state, pinnedAt: trust.pinnedAt } : null,
        toolCount,
      };
    });
    return c.json({ upstreams: rows });
  });

  api.post("/upstreams", admin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.namespace !== "string" || typeof body.url !== "string") {
      return c.json({ error: "namespace and url are required" }, 400);
    }
    const namespace = body.namespace.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(namespace)) {
      return c.json({ error: "namespace must be 1-32 chars [a-z0-9_-]" }, 400);
    }
    configStore.upsertUpstream({
      id: randomUUID(),
      namespace,
      displayName: typeof body.displayName === "string" ? body.displayName : namespace,
      url: body.url,
      protocolVersion: typeof body.protocolVersion === "string" ? body.protocolVersion : null,
      enabled: body.enabled !== false,
      driftAction: body.driftAction === "log" || body.driftAction === "notify" ? body.driftAction : "block",
      headerMap:
        typeof body.headerMap === "object" && body.headerMap !== null
          ? (body.headerMap as Record<string, string>)
          : {},
    });
    return c.json({ ok: true, namespace });
  });

  api.put("/upstreams/:namespace", admin, async (c) => {
    const namespace = c.req.param("namespace");
    const existing = configStore.getUpstream(namespace);
    if (!existing) return c.json({ error: "not found" }, 404);
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    configStore.upsertUpstream({
      id: existing.id,
      namespace,
      displayName: typeof body.displayName === "string" ? body.displayName : existing.displayName,
      url: typeof body.url === "string" ? body.url : existing.url,
      protocolVersion:
        typeof body.protocolVersion === "string" ? body.protocolVersion : existing.protocolVersion,
      enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
      driftAction:
        body.driftAction === "log" || body.driftAction === "notify" || body.driftAction === "block"
          ? body.driftAction
          : existing.driftAction,
      headerMap:
        typeof body.headerMap === "object" && body.headerMap !== null
          ? (body.headerMap as Record<string, string>)
          : existing.headerMap,
    });
    return c.json({ ok: true, namespace });
  });

  api.delete("/upstreams/:namespace", admin, (c) => {
    configStore.deleteUpstream(c.req.param("namespace"));
    return c.json({ ok: true });
  });

  api.post("/upstreams/:namespace/pin", admin, async (c) => {
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups, notifier);
    try {
      const snapshot = await deps.trust.pinUpstream(c.req.param("namespace"));
      return c.json({ ok: true, hash: snapshotToHash(snapshot), toolCount: snapshot.tools.length });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  api.get("/upstreams/:namespace/tools", anyAuth, (c) => {
    const namespace = c.req.param("namespace");
    const trust = configStore.getTrust(namespace);
    if (!trust) return c.json({ error: "upstream not pinned" }, 404);
    const snapshot = JSON.parse(trust.snapshot) as TrustSnapshot;
    const tools = snapshot.tools.map((t) => {
      const fullName = `${namespace}_${t.name}`;
      const policy = configStore.getPolicy(namespace, fullName) ?? configStore.getPolicy(namespace, "*");
      return {
        name: fullName,
        upstreamName: t.name,
        description: t.description,
        enabled: policy?.enabled ?? false,
        guard: policy?.guard ?? "none",
        timeoutAction: policy?.timeoutAction ?? null,
        ttlMinutes: policy?.ttlMinutes ?? null,
      };
    });
    return c.json({
      namespace,
      pinnedHash: trust.pinnedHash,
      pinnedAt: trust.pinnedAt,
      state: trust.state,
      tools,
    });
  });

  api.get("/upstreams/:namespace/policies", anyAuth, (c) => {
    return c.json({ policies: configStore.listPolicies(c.req.param("namespace")) });
  });

  api.put("/upstreams/:namespace/policies/:tool", admin, async (c) => {
    const upstream = c.req.param("namespace");
    const tool = c.req.param("tool");
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    configStore.upsertPolicy({
      upstream,
      tool,
      enabled: body.enabled !== false,
      guard:
        body.guard === "reason" || body.guard === "hitl" || body.guard === "none" ? body.guard : "none",
      timeoutAction:
        body.timeoutAction === "approve" || body.timeoutAction === "deny" ? body.timeoutAction : null,
      ttlMinutes: typeof body.ttlMinutes === "number" ? body.ttlMinutes : null,
    });
    return c.json({ ok: true });
  });

  api.delete("/upstreams/:namespace/policies/:tool", admin, (c) => {
    configStore.deletePolicy(c.req.param("namespace"), c.req.param("tool"));
    return c.json({ ok: true });
  });

  // settings -----------------------------------------------------------------
  api.get("/settings", anyAuth, (c) => {
    return c.json({ settings: listSettings(configStore) });
  });

  api.put("/settings", admin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { settings?: Record<string, string> } | null;
    if (body?.settings) {
      for (const [key, value] of Object.entries(body.settings)) {
        configStore.setSetting(key, String(value));
      }
    }
    return c.json({ settings: listSettings(configStore) });
  });

  // audit + approvals ---------------------------------------------------------
  api.get("/audit", anyAuth, async (c) => {
    const url = new URL(c.req.url);
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups, notifier);
    const rows = await deps.store.queryAudit({
      tool: url.searchParams.get("tool") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      caller_id: url.searchParams.get("caller_id") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 100),
    });
    return c.json({ rows });
  });

  api.get("/approvals", anyAuth, async (c) => {
    const url = new URL(c.req.url);
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups, notifier);
    const status = url.searchParams.get("status") as "pending" | "approved" | "denied" | "expired" | null;
    const rows = await deps.store.listApprovals(status ?? undefined);
    return c.json({
      approvals: rows.map((r) => ({
        approval_id: r.id,
        tool: r.tool,
        status: r.status,
        reason: r.reason,
        created_at: r.created_at,
        expires_at: r.expires_at,
      })),
    });
  });

  api.post("/approvals/:id/resolve", operator, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { action?: "approve" | "deny" } | null;
    if (!body || (body.action !== "approve" && body.action !== "deny")) {
      return c.json({ error: "action must be approve|deny" }, 400);
    }
    const action: "approved" | "denied" = body.action === "approve" ? "approved" : "denied";
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups, notifier);
    const row = await deps.store.getApproval(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "pending") return c.json({ error: "already resolved" }, 409);
    await deps.store.setApprovalStatus(row.id, action, { hermesUserId: c.get("auth").callerId });
    return c.json({ ok: true, approval_id: row.id, status: body.action });
  });

  // clients (machine auth tokens) ---------------------------------------------
  api.get("/clients", anyAuth, (c) => {
    return c.json({
      clients: configStore.listClients().map(({ secretHash: _hash, ...rest }) => rest),
    });
  });

  api.post("/clients", admin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string; scopes?: string } | null;
    if (!body) {
      return c.json({ error: "name is required" }, 400);
    }
    const name = body.name?.trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    configStore.upsertClient({
      id,
      name,
      secretHash: createHash("sha256").update(token).digest("hex"),
      scopes: body.scopes ?? "mcp",
      enabled: true,
    });
    return c.json({ ok: true, client_id: id, token }); // token shown once
  });

  api.delete("/clients/:id", admin, (c) => {
    configStore.deleteClient(c.req.param("id"));
    return c.json({ ok: true });
  });

  // secrets -------------------------------------------------------------------
  api.get("/secrets", anyAuth, (c) => {
    return c.json({
      secrets: db.prepare("SELECT name, created_at FROM secrets ORDER BY name").all(),
    });
  });

  api.put("/secrets/:name", admin, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { value?: string } | null;
    if (typeof body?.value !== "string" || body.value.length === 0) {
      return c.json({ error: "value is required" }, 400);
    }
    configStore.setSecret(c.req.param("name"), secrets.encrypt(body.value));
    return c.json({ ok: true });
  });

  api.delete("/secrets/:name", admin, (c) => {
    configStore.deleteSecret(c.req.param("name"));
    return c.json({ ok: true });
  });

  app.route("/api", api);
}

function listSettings(configStore: ConfigStore): Record<string, string> {
  return Object.fromEntries(configStore.listSettings().map(({ key, value }) => [key, value]));
}

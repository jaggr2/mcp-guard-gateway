import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "../config";
import type { HermesBridge } from "../hermes/bridge";
import { NoopHermesBridge } from "../hermes/bridge";
import { buildDeps } from "../mcp";
import { deleteMemoryFile, readMemoryFile, writeMemoryFile } from "../memory/files";
import {
  checkSkillSource,
  listSkillSources,
  updateSkillFromSource,
  type SkillCheckResult,
} from "../memory/sources";
import {
  ConfigStore,
  type LifecycleMode,
  type ProjectTemplate,
} from "../store/config";
import { SecretBox } from "../secrets";
import { authenticateAdmin, isAdmin, isOperator, type AuthContext } from "../auth/middleware";
import { isTrustedPeer, normalizeAddr } from "../auth/peer";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** Resolves the request's TCP peer; empty when no socket info is available. */
function requestPeer(c: Context): string {
  try {
    return normalizeAddr(getConnInfo(c).remote.address ?? "");
  } catch {
    return "";
  }
}
import { snapshotToHash, type TrustSnapshot } from "../trust/pin";
import { processLearningProposal } from "../memory/learning";
import { runSandboxCtl } from "../sandboxes/proxy";

type AppEnv = { Variables: { auth: AuthContext } };
type App = Hono<AppEnv>;

function requireAuth(
  config: GatewayConfig,
  configStore: ConfigStore,
  check: (ctx: AuthContext, config: GatewayConfig) => boolean,
  opts: { allowTrustedPeer?: boolean } = {}
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const peer = requestPeer(c);
    let ctx = authenticateAdmin(c.req.raw, config, configStore, peer);
    if (!ctx && opts.allowTrustedPeer && isTrustedPeer(peer, config.trustedIdentityPeers)) {
      // Trusted local callers (host scripts) need no identity headers for
      // read-only endpoints.
      ctx = { callerId: "local", groups: [] };
    }
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

  const anyAuth = requireAuth(config, configStore, () => true);
  const admin = requireAuth(config, configStore, isAdmin);
  const operator = requireAuth(config, configStore, isOperator);
  // Host-local scrapes (ha-sweep.sh) may call read-only endpoints without headers.
  const trustedOrAuth = requireAuth(config, configStore, () => true, { allowTrustedPeer: true });

  // Local unauthenticated summary endpoint consumed by host ha-sweep.sh (127.0.0.1)
  api.get("/ha-summary", trustedOrAuth, async (c) => {
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
        url: `https://oc.jaggi.xyz/s/${p.slug}`,
        repo_url: p.repoUrl,
        cost_today: u.costTodayUsd,
        cost_month: u.costMonthUsd,
        tokens_today: u.tokensToday,
        last_active_at: p.lastActiveAt,
      };
    });

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
      budget_alert: budgetAlert,
      budget_alert_reason: budgetAlertReason,
    });
  });

  // Home Assistant button / actionable notification callback for HITL approvals.
  // Auth: operator identity (trusted-ingress forward-auth headers) or an
  // operator/admin service token (ha-bridge sends one).
  api.post("/approvals/latest-decision", operator, async (c) => {
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
    const resolved = await baseDeps.store.getApproval(approvalId);
    if (resolved) {
      void notifier.sendResolutionCard(resolved.id, resolved.tool, resolved.reason, status);
    }
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
        url: `https://oc.jaggi.xyz/s/${p.slug}`,
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
        browserAllowedDomains: p.browserAllowedDomains,
        browserInternalTargets: p.browserInternalTargets,
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
      browserAllowedDomains:
        typeof body.browserAllowedDomains === "string" ? body.browserAllowedDomains : "",
      browserInternalTargets:
        typeof body.browserInternalTargets === "string" ? body.browserInternalTargets : "",
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

    void notifier.notify(`🚀 Provisioned OpenCode sandbox '${slug}' (https://oc.jaggi.xyz/s/${slug})`);
    return c.json({
      ok: true,
      slug,
      url: `https://oc.jaggi.xyz/s/${slug}`,
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
      browserAllowedDomains:
        typeof body.browserAllowedDomains === "string" ? body.browserAllowedDomains : existing.browserAllowedDomains,
      browserInternalTargets:
        typeof body.browserInternalTargets === "string" ? body.browserInternalTargets : existing.browserInternalTargets,
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

  // Memory library tree (agent-memory repo overview) --------------------------
  api.get("/memory/tree", anyAuth, (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    const listNames = (p: string): string[] => {
      try {
        return readdirSync(p).filter((n) => !n.startsWith("."));
      } catch {
        return [];
      }
    };
    const isDir = (p: string): boolean => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    };

    const skills = listNames(join(dir, "skills"))
      .filter((name) => isDir(join(dir, "skills", name)))
      .sort()
      .map((name) => {
        const skillDir = join(dir, "skills", name);
        let description = "";
        const skillMd = join(skillDir, "SKILL.md");
        if (existsSync(skillMd)) {
          const text = readFileSync(skillMd, "utf8").slice(0, 3000);
          const m = text.match(/^---[\s\S]*?description:[ \t]*(.+)/);
          if (m) description = m[1].trim().replace(/^["']|["']$/g, "").slice(0, 140);
        }
        return {
          name,
          description,
          files: listNames(skillDir).length,
          fileNames: listNames(skillDir).sort(),
          path: `skills/${name}`,
        };
      });

    const memories = listNames(join(dir, "memories"))
      .sort()
      .map((name) => ({ name, path: `memories/${name}` }));

    const journal = listNames(join(dir, "journal"))
      .filter((name) => isDir(join(dir, "journal", name)))
      .sort()
      .map((name) => {
        const files = listNames(join(dir, "journal", name)).sort();
        return { name, count: files.length, files, path: `journal/${name}` };
      });

    const other = listNames(dir)
      .filter((name) => !isDir(join(dir, name)))
      .sort();

    return c.json({ root: dir, skills, memories, journal, other });
  });

  // Memory file detail (view + manual edit) -----------------------------------
  api.get("/memory/file", anyAuth, (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    const res = readMemoryFile(dir, c.req.query("path") ?? "");
    return c.json(res, "error" in res ? 404 : 200);
  });

  api.put("/memory/file", operator, async (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as {
      path?: string;
      content?: string;
      commit?: boolean;
    } | null;
    if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
      return c.json({ error: "path and content are required" }, 400);
    }
    const res = writeMemoryFile(dir, body.path, body.content, body.commit !== false);
    return c.json(res, "error" in res ? 400 : 200);
  });

  api.delete("/memory/file", operator, (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    const res = deleteMemoryFile(dir, c.req.query("path") ?? "", true);
    return c.json(res, "error" in res ? 400 : 200);
  });

  // Usage log (per-project/client token & cost consumption) --------------------
  api.get("/usage/log", anyAuth, (c) => {
    const period = c.req.query("period") ?? "24h";
    const hours = period === "30d" ? 24 * 30 : period === "7d" ? 24 * 7 : 24;
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const project = c.req.query("project") || undefined;

    let breakdown = configStore.usageBreakdown(since);
    let entries = configStore.usageEntries(since, 200);
    if (project) {
      breakdown = breakdown.filter((b) => b.project === project);
      entries = entries.filter((e) => e.project === project);
    }
    const totals = breakdown.reduce(
      (acc, b) => ({
        costUsd: acc.costUsd + b.costUsd,
        requests: acc.requests + b.requests,
        errors: acc.errors + b.errors,
        inputTokens: acc.inputTokens + b.inputTokens,
        outputTokens: acc.outputTokens + b.outputTokens,
        cachedTokens: acc.cachedTokens + b.cachedTokens,
        reasoningTokens: acc.reasoningTokens + b.reasoningTokens,
      }),
      { costUsd: 0, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
    );
    return c.json({ period, since, project: project ?? null, totals, breakdown, entries: entries.slice(0, 100) });
  });

  // Skill sources (source_url frontmatter → check/update against upstream) ----
  api.get("/memory/skills/sources", anyAuth, (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    return c.json({ skills: listSkillSources(dir) });
  });

  api.post("/memory/skills/check", operator, async (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    const names = body?.name
      ? [body.name]
      : listSkillSources(dir).map((s) => s.name);
    const results: SkillCheckResult[] = [];
    for (const name of names) {
      results.push(await checkSkillSource(dir, name));
    }
    return c.json({ results });
  });

  api.post("/memory/skills/update", operator, async (c) => {
    const dir = config.agentMemoryDir;
    if (!dir || !existsSync(dir)) {
      return c.json({ error: "agent-memory not mounted", path: dir ?? null }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
    if (!body?.name) return c.json({ error: "name is required" }, 400);
    const res = await updateSkillFromSource(dir, body.name);
    return c.json(res, "error" in res ? 400 : 200);
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
    void notifier.sendResolutionCard(row.id, row.tool, row.reason, action);
    return c.json({ ok: true, approval_id: row.id, status: body.action });
  });

  /**
   * One-tap decision links for the HA dashboard's per-row ✅/❌ buttons
   * (`GET /api/approvals/:id/decide?action=approve|deny`). Behind Authelia
   * forward-auth like the rest of the admin API, so the operator's existing
   * session authorizes the tap — no capability secrets in dashboards.
   */
  api.get("/approvals/:id/decide", operator, async (c) => {
    // CSRF guard: only accept plain top-level navigations (a tapped link), never
    // cross-site subresource loads (img/script/fetch) or form posts.
    const dest = c.req.header("sec-fetch-dest");
    const mode = c.req.header("sec-fetch-mode");
    if ((dest !== undefined && dest !== "document") || (mode !== undefined && mode !== "navigate")) {
      return c.text("forbidden", 403);
    }
    const raw = (c.req.query("action") ?? "").toLowerCase();
    if (raw !== "approve" && raw !== "deny") {
      return c.text("action must be approve|deny", 400);
    }
    const action: "approved" | "denied" = raw === "approve" ? "approved" : "denied";
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups, notifier);
    const row = await deps.store.getApproval(c.req.param("id"));

    let headline: string;
    if (!row) {
      headline = "❓ Approval not found";
    } else if (row.status !== "pending") {
      headline = `⚠️ Already ${row.status}`;
    } else {
      await deps.store.setApprovalStatus(row.id, action, { hermesUserId: c.get("auth").callerId });
      void notifier.sendResolutionCard(row.id, row.tool, row.reason, action);
      headline = raw === "approve" ? "✅ Approved" : "❌ Denied";
    }
    const detail = row ? `${row.tool} — ${row.reason}` : c.req.param("id");
    const hassBase = (config.hassUrl ?? configStore.getSetting("hass.url") ?? "").replace(/\/$/, "");
    const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${headline}</title>
<style>body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:2rem 2.5rem;text-align:center;max-width:90vw}
h1{margin:0 0 .5rem;font-size:1.4rem}p{color:#8b949e;margin:.3rem 0;font-size:.92rem}</style></head>
<body><div class="card"><h1>${headline}</h1><p>${detail.replace(/[<>&]/g, "")}</p>
<p>Taking you back to Home Assistant…</p>
<p><a href="${hassBase}/dashboard-rack/ai-sandboxes" style="color:#58a6ff">Open the approvals card</a></p></div>
<script>setTimeout(function(){ if (history.length > 1) history.back(); }, 1200);</script>
</body></html>`;
    return c.html(html);
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

  // browser orchestrator proxy (Browser Broker) --------------------------------
  // Thin pass-through to the browser-host orchestrator; response shapes pass
  // through unchanged so the UI/HA can evolve independently. Auth: Warden's own
  // route auth in front, ORCHESTRATOR_TOKEN (encrypted secrets table) behind.
  const orchestratorFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
    const ciphertext = configStore.getSecret("ORCHESTRATOR_TOKEN");
    if (ciphertext) {
      try {
        headers.Authorization = `Bearer ${secrets.decrypt(ciphertext)}`;
      } catch {
        /* undecryptable secret — proxy without the bearer token */
      }
    }
    const base = (configStore.getSetting("browser.orchestratorUrl") ?? config.browserOrchestratorUrl).replace(/\/$/, "");
    try {
      return await fetch(`${base}${path}`, { ...init, headers });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "browser orchestrator unreachable",
          detail: err instanceof Error ? err.message : String(err),
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  };

  const passThrough = (upstream: Response): Response =>
    new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });

  api.get("/browser/sessions", anyAuth, async () => {
    return passThrough(await orchestratorFetch("/api/sessions"));
  });

  api.get("/browser/sessions/:slug", anyAuth, async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-z0-9-]{1,32}$/.test(slug)) return c.json({ error: "invalid slug" }, 400);
    return passThrough(await orchestratorFetch(`/api/sessions/${slug}`));
  });

  api.post("/browser/sessions/:slug/mode", operator, async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-z0-9-]{1,32}$/.test(slug)) return c.json({ error: "invalid slug" }, 400);
    return passThrough(
      await orchestratorFetch(`/api/sessions/${slug}/mode`, {
        method: "POST",
        headers: { "Content-Type": c.req.header("content-type") ?? "application/json" },
        body: await c.req.text(),
      })
    );
  });

  api.get("/browser/artifacts/:id", anyAuth, async (c) => {
    return passThrough(await orchestratorFetch(`/artifacts/${c.req.param("id")}`));
  });

  app.route("/api", api);
}

function listSettings(configStore: ConfigStore): Record<string, string> {
  return Object.fromEntries(configStore.listSettings().map(({ key, value }) => [key, value]));
}

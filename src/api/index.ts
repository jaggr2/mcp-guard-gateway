import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type Database from "better-sqlite3";
import type { GatewayConfig } from "../config";
import { buildDeps } from "../mcp";
import { ConfigStore } from "../store/config";
import { SecretBox } from "../secrets";
import { authenticateAdmin, isAdmin, isOperator, type AuthContext } from "../auth/middleware";
import { snapshotToHash, type TrustSnapshot } from "../trust/pin";

type AppEnv = { Variables: { auth: AuthContext } };
type App = Hono<AppEnv>;

function requireAuth(config: GatewayConfig, check: (ctx: AuthContext, config: GatewayConfig) => boolean): MiddlewareHandler<AppEnv> {
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

export function registerApi(app: Hono, config: GatewayConfig, db: Database.Database): void {
  const configStore = new ConfigStore(db);
  const secrets = new SecretBox(config.masterKey);
  const api: App = new Hono();

  const anyAuth = requireAuth(config, () => true);
  const admin = requireAuth(config, isAdmin);
  const operator = requireAuth(config, isOperator);

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
    return c.json({
      publicUrl: config.publicUrl,
      issuers: config.issuers.map((i) => i.issuer),
      upstreams,
    });
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
      headerMap: typeof body.headerMap === "object" && body.headerMap !== null ? (body.headerMap as Record<string, string>) : {},
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
      protocolVersion: typeof body.protocolVersion === "string" ? body.protocolVersion : existing.protocolVersion,
      enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
      driftAction: body.driftAction === "log" || body.driftAction === "notify" || body.driftAction === "block" ? body.driftAction : existing.driftAction,
      headerMap: typeof body.headerMap === "object" && body.headerMap !== null ? (body.headerMap as Record<string, string>) : existing.headerMap,
    });
    return c.json({ ok: true, namespace });
  });

  api.delete("/upstreams/:namespace", admin, (c) => {
    configStore.deleteUpstream(c.req.param("namespace"));
    return c.json({ ok: true });
  });

  api.post("/upstreams/:namespace/pin", admin, async (c) => {
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups);
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
    return c.json({ namespace, pinnedHash: trust.pinnedHash, pinnedAt: trust.pinnedAt, state: trust.state, tools });
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
      guard: body.guard === "reason" || body.guard === "hitl" || body.guard === "none" ? body.guard : "none",
      timeoutAction: body.timeoutAction === "approve" || body.timeoutAction === "deny" ? body.timeoutAction : null,
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
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups);
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
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups);
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
    const deps = buildDeps(config, db, c.get("auth").callerId, c.get("auth").groups);
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
    return c.json({ secrets: db.prepare("SELECT name, created_at FROM secrets ORDER BY name").all() });
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

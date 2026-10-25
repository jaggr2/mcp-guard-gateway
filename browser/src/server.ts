import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono, type Context, type Next } from "hono";
import type { Config } from "./config.js";
import { isArtifactId, type ArtifactStore } from "./artifacts.js";
import type { Logger } from "./logger.js";
import { novncHandler, sessionViewPage, VIEWER_JS } from "./novnc.js";
import type { ProfileStore } from "./profiles.js";
import type { JsonRpcMessage } from "./rpc.js";
import {
  RegistryError,
  type McpKind,
  type SessionInfo,
  type SessionRegistry,
} from "./registry.js";
import { errorResponse, takeoverResult } from "./supervisor.js";
import { DEFAULT_PROJECT, isProjectId, isSlug } from "./slug.js";
import { TAKEOVER_ERROR } from "./machine.js";

export interface ServerDeps {
  config: Config;
  registry: SessionRegistry;
  artifacts: ArtifactStore;
  profiles: ProfileStore;
  log: Logger;
}

function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length || presented.length === 0) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

function isJsonRpcRequest(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  return msg["jsonrpc"] === "2.0" && typeof msg["method"] === "string";
}

let callCounter = 0;

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const { config, registry, artifacts, log } = deps;

  // ------------------------------------------------------------ auth
  // Management + facade endpoints require ORCHESTRATOR_TOKEN (401 otherwise).
  // Viewer routes (/novnc/, /, WS /p/:project/vnc|cast) rely on Authelia.
  const auth = async (c: Context, next: Next): Promise<Response | void> => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!tokenMatches(presented, config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
    return undefined;
  };
  app.use("/api/*", auth);
  app.use("/mcp", auth);
  app.use("/devtools", auth);
  app.use("/p/*/mcp", auth);
  app.use("/p/*/devtools", auth);
  app.use("/artifacts/*", auth);
  app.use("/healthz", auth);
  app.use("/metrics", auth);

  const registryError = (c: Context, err: unknown): Response => {
    if (err instanceof RegistryError) return c.json({ error: err.message }, err.status);
    log.error("request failed", { err: String(err) });
    return c.json({ error: String(err) }, 500);
  };

  // ------------------------------------------------------- MCP facade
  async function handleFacade(c: Context, project: string, kind: McpKind): Promise<Response> {
    if (!isProjectId(project)) return c.json({ error: "invalid project slug" }, 400);
    let message: JsonRpcMessage;
    try {
      const body: unknown = await c.req.json();
      if (!isJsonRpcRequest(body)) {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }, 200);
      }
      message = body;
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 200);
    }
    const callId = `call-${Date.now()}-${++callCounter}`;
    const startedAt = Date.now();
    let response: JsonRpcMessage | null;
    try {
      const session = await registry.ensure(project);
      // Mode gate (Part 10.4): in operator mode everything but GET /api/* is
      // rejected with the takeover error — the agent just retries later.
      if (session.mode === "operator") {
        if (message.id === undefined) return c.body(null, 202);
        response =
          message.method === "tools/call"
            ? takeoverResult(message.id)
            : errorResponse(message.id, -32000, TAKEOVER_ERROR);
      } else {
        response = await session.rpc(kind, message);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("facade call failed", { project, kind, err: msg });
      return c.json(
        {
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32000, message: msg },
        },
        200,
      );
    }
    // Artifact capture: scan the session's output dir after tools/call (Part 10.6).
    if (
      message.method === "tools/call" &&
      response &&
      response.result !== undefined &&
      response.error === undefined
    ) {
      try {
        const captured = await artifacts.capture(project, callId, startedAt);
        if (captured.length > 0) {
          const result = response.result as Record<string, unknown>;
          const meta = (result["_meta"] as Record<string, unknown>) ?? {};
          result["_meta"] = {
            ...meta,
            artifact_id: captured[0].id,
            artifact_ids: captured.map((a) => a.id),
          };
        }
      } catch (err) {
        log.warn("artifact capture failed", { project, err: String(err) });
      }
    }
    if (response === null) return c.body(null, 202);
    return c.json(response, 200);
  }

  app.post("/mcp", async (c) => {
    const caller = c.req.header("x-warden-caller");
    if (caller !== undefined && !isProjectId(caller)) return c.json({ error: "invalid X-Warden-Caller" }, 400);
    return handleFacade(c, caller ?? DEFAULT_PROJECT, "playwright");
  });
  app.post("/devtools", async (c) => {
    const caller = c.req.header("x-warden-caller");
    if (caller !== undefined && !isProjectId(caller)) return c.json({ error: "invalid X-Warden-Caller" }, 400);
    return handleFacade(c, caller ?? DEFAULT_PROJECT, "devtools");
  });
  app.post("/p/:project/mcp", (c) => handleFacade(c, c.req.param("project"), "playwright"));
  app.post("/p/:project/devtools", (c) => handleFacade(c, c.req.param("project"), "devtools"));

  // ----------------------------------------------------- management API
  app.get("/api/sessions", async (c) => c.json({ sessions: await registry.list() }));

  app.get("/api/sessions/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isProjectId(slug)) return c.json({ error: "invalid project slug" }, 400);
    try {
      const info = await registry.info(slug);
      if (!info) return c.json({ error: `no session for project ${slug}` }, 404);
      return c.json(info);
    } catch (err) {
      return registryError(c, err);
    }
  });

  app.post("/api/sessions/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isProjectId(slug)) return c.json({ error: "invalid project slug" }, 400);
    try {
      const session = await registry.ensure(slug); // idempotent boot
      return c.json(await session.toInfo(), 200);
    } catch (err) {
      return registryError(c, err);
    }
  });

  app.delete("/api/sessions/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isProjectId(slug)) return c.json({ error: "invalid project slug" }, 400);
    try {
      await registry.teardown(slug);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return registryError(c, err);
    }
  });

  app.post("/api/sessions/:slug/mode", async (c) => {
    const slug = c.req.param("slug");
    if (!isProjectId(slug)) return c.json({ error: "invalid project slug" }, 400);
    let body: { mode?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.mode !== "agent" && body.mode !== "operator") {
      return c.json({ error: "mode must be 'agent' or 'operator'" }, 400);
    }
    try {
      return c.json(await registry.setMode(slug, body.mode));
    } catch (err) {
      return registryError(c, err);
    }
  });

  app.post("/api/sessions/:slug/profile", async (c) => {
    const slug = c.req.param("slug");
    if (!isProjectId(slug)) return c.json({ error: "invalid project slug" }, 400);
    let body: { action?: string; name?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const action = body.action;
    if (action !== "attach" && action !== "commit" && action !== "detach") {
      return c.json({ error: "action must be attach|commit|detach" }, 400);
    }
    if (typeof body.name !== "string" || !isSlug(body.name)) {
      return c.json({ error: "name must be a slug" }, 400);
    }
    try {
      return c.json(await registry.profileAction(slug, action, body.name));
    } catch (err) {
      return registryError(c, err);
    }
  });

  app.get("/api/sessions/:slug/artifacts", async (c) => {
    const slug = c.req.param("slug");
    if (!isProjectId(slug)) return c.json({ error: "invalid project slug" }, 400);
    return c.json({ artifacts: artifacts.list(slug) });
  });

  app.get("/artifacts/:id", async (c) => {
    const id = c.req.param("id");
    if (!isArtifactId(id)) return c.json({ error: "invalid artifact id" }, 400);
    const artifact = artifacts.get(id);
    if (!artifact) return c.json({ error: "unknown artifact" }, 404);
    try {
      const bytes = await readFile(artifact.path);
      return c.body(new Uint8Array(bytes), 200, {
        "content-type": "application/octet-stream",
        "content-disposition": `inline; filename="${artifact.name}"`,
      });
    } catch {
      return c.json({ error: "artifact bytes missing" }, 404);
    }
  });

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      role: "browser-orchestrator",
      takeoverError: TAKEOVER_ERROR,
    }),
  );

  app.get("/metrics", async (c) => {
    const m = await registry.metrics();
    const lines = [
      "# TYPE browser_pool_slots gauge",
      `browser_pool_slots_total ${m.poolTotal}`,
      `browser_pool_slots_in_use ${m.poolUsed}`,
      "# TYPE browser_sessions gauge",
      ...Object.entries(m.sessionsByState).map(
        ([state, count]) => `browser_sessions{state="${state}"} ${count}`,
      ),
      "# TYPE browser_boots_total counter",
      `browser_boots_total ${m.bootsTotal}`,
      "# TYPE browser_crashes_total counter",
      `browser_crashes_total ${m.crashesTotal}`,
      "# TYPE browser_screencast_frames_total counter",
      `browser_screencast_frames_total ${m.screencastFramesTotal}`,
      "# TYPE browser_ram_free_bytes gauge",
      `browser_ram_free_bytes ${m.freeRamBytes}`,
    ];
    return c.text(`${lines.join("\n")}\n`);
  });

  // -------------------------------------------------------- viewer routes
  app.get("/novnc/*", novncHandler(config.novncPath));

  // HTTP GET on the VNC path hands back the preconfigured noVNC client.
  app.get("/p/:project/vnc", (c) => {
    const project = c.req.param("project");
    if (!isProjectId(project)) return c.text("invalid project slug", 400);
    return c.redirect(`/novnc/vnc.html?path=p/${encodeURIComponent(project)}/vnc&autoconnect=1&resize=scale`);
  });

  // Per-session fallback view page: noVNC in an iframe + explicit Take Over /
  // Release buttons (which call the mode API and reconnect the noVNC WS).
  app.get("/p/:project/view", (c) => {
    const project = c.req.param("project");
    if (!isProjectId(project)) return c.text("invalid project slug", 400);
    return c.html(sessionViewPage(project));
  });

  // Minimal session picker fallback page (steady state: Warden UI).
  app.get("/", async (c) => {
    let sessions: SessionInfo[] = [];
    try {
      sessions = await registry.list();
    } catch {
      sessions = [];
    }
    const rows = sessions
      .map(
        (s) =>
          `<tr><td>${s.project}</td><td>${s.state}</td><td>${s.mode}</td>` +
          `<td>${s.viewers}</td><td>${s.takeoverViewers}</td>` +
          `<td><a href="/p/${encodeURIComponent(s.project)}/view">view</a></td>` +
          `<td><a href="/p/${encodeURIComponent(s.project)}/vnc">noVNC</a></td>` +
          `<td>${s.currentUrl ?? ""}</td>` +
          `<td><button onclick="takeOver('${s.project}')">Take Over</button>` +
          `<button onclick="releaseSession('${s.project}')">Release</button></td></tr>`,
      )
      .join("\n");
    return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>browser-orchestrator</title></head>
<body style="font-family: sans-serif; margin: 2rem;">
  <h1>Browser sessions</h1>
  <p>Watching (the <em>view</em> page or <em>noVNC</em> link) is passive and never blocks the
     agent. <strong>Take Over</strong> switches the session to <code>operator</code> mode and
     reconnects the viewer to the interactive display; <strong>Release</strong> hands it back.</p>
  <table border="1" cellpadding="6" cellspacing="0">
    <tr><th>project</th><th>state</th><th>mode</th><th>watchers</th><th>takeover</th>
        <th>viewer</th><th>noVNC</th><th>current URL</th><th>mode control</th></tr>
    ${rows || '<tr><td colspan="9">no live sessions</td></tr>'}
  </table>
${VIEWER_JS}
  <script>
    async function takeOver(slug) { show(await setMode(slug, 'operator')); }
    async function releaseSession(slug) { show(await setMode(slug, 'agent')); }
    function show(info) { if (info) location.reload(); }
  </script>
</body></html>`);
  });

  return app;
}

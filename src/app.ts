import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type GatewayConfig } from "./config";
import { openDatabase } from "./db/connection";
import { buildDeps, buildMcpServer } from "./mcp";
import { authenticateMcp } from "./auth/middleware";
import { authServerMetadata, bearerChallenge, protectedResourceMetadata } from "./auth/metadata";
import { registerApi } from "./api";
import { bootstrap } from "./bootstrap";
import { HermesBridgeImpl, type HermesBridge } from "./hermes/bridge";
import { ConfigStore } from "./store/config";

export interface AppRuntime {
  config: GatewayConfig;
  db: Database.Database;
  hermes: HermesBridge;
}

const WEB_ROOT = join(process.cwd(), "web", "dist", "web", "browser");

export function createApp(env: Record<string, string | undefined>): Hono {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  bootstrap(config, db);

  const configStore = new ConfigStore(db);
  const hermes = new HermesBridgeImpl({
    bridgeUrl: config.hermesBridgeUrl,
    conversationKey: configStore.getSetting("hermes.conversationKey"),
    store: buildDeps(config, db, "system", []).store,
  });
  void hermes.start().catch(() => undefined);

  const runtime: AppRuntime = { config, db, hermes };
  const app = new Hono();

  startBackgroundTasks(config, db);

  app.get("/healthz", (c) => {
    const upstreams = configStore.listUpstreams().length;
    return c.json({ ok: true, upstreams });
  });

  // OAuth discovery ----------------------------------------------------------
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(config)));
  app.get("/.well-known/oauth-authorization-server", async (c) => {
    const meta = await authServerMetadata(config);
    return meta ? c.json(meta) : c.json({ error: "no authorization server configured" }, 404);
  });

  // MCP Streamable HTTP ------------------------------------------------------
  app.all("/mcp", async (c) => handleMcp(c.req.raw, runtime));

  // Admin API ----------------------------------------------------------------
  registerApi(app, config, db);

  // Angular SPA --------------------------------------------------------------
  app.use("*", serveStatic({ root: WEB_ROOT }));
  app.use("*", async (c) => {
    if (c.req.method === "GET") {
      try {
        const index = await readFile(join(WEB_ROOT, "index.html"), "utf8");
        return new Response(index, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      } catch {
        return c.text("UI not built — run `npm run build` in web/", 404);
      }
    }
    return c.text("Not Found", 404);
  });

  return app;
}

async function handleMcp(request: Request, runtime: AppRuntime): Promise<Response> {
  const { config, db, hermes } = runtime;
  const configStore = new ConfigStore(db);
  const ctx = await authenticateMcp(request, config, configStore);
  if (config.issuers.length > 0 && ctx.callerId === "unauthenticated") {
    return new Response("Unauthorized", { status: 401, headers: bearerChallenge(config) });
  }

  const deps = buildDeps(config, db, ctx.callerId, ctx.groups, hermes);
  const server = buildMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo: ctx.authInfo });
}

/**
 * Background jobs: pin any seeded/configured upstream that has no baseline yet
 * (fail-closed if unreachable), then re-verify all upstreams' trust baselines
 * every 10 minutes and notify via Hermes on drift.
 */
function startBackgroundTasks(config: GatewayConfig, db: Database.Database): void {
  const deps = buildDeps(config, db, "system", []);

  void (async () => {
    for (const client of deps.registry.list()) {
      if (deps.configStore.getTrust(client.namespace)) {
        continue;
      }
      try {
        await deps.trust.pinUpstream(client.namespace);
      } catch {
        // upstream unreachable at boot — stays unpinned (fail-closed)
      }
    }
  })();

  const timer = setInterval(() => {
    deps.trust.verifyAll().catch(() => undefined);
  }, 10 * 60_000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

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
import { type HermesBridge } from "./hermes/bridge";
import { HomeAssistantNotifier } from "./notify/homeassistant";
import { ConfigStore } from "./store/config";
import { SecretBox } from "./secrets";
import { handleLlmProxy } from "./llm/proxy";
import { handleAwsCredsBroker, handleGitCredsBroker } from "./brokers/credentials";
import {
  extractSandboxSlugFromHost,
  handleSandboxReverseProxy,
  sweepIdleSandboxes,
} from "./sandboxes/proxy";

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
  const secrets = new SecretBox(config.masterKey);
  const baseDeps = buildDeps(config, db, "system", []);
  const notifier = new HomeAssistantNotifier({
    hassUrl: config.hassUrl ?? configStore.getSetting("hass.url"),
    hassToken: config.hassToken,
    notifyService: config.hassNotifyService,
    publicUrl: config.publicUrl,
    store: baseDeps.store,
  });
  void notifier.start().catch(() => undefined);

  const runtime: AppRuntime = { config, db, hermes: notifier };
  const app = new Hono();

  startBackgroundTasks(config, db, notifier);

  // Wake-on-visit reverse proxy when Host is `<project>.oc.jaggi.xyz` ----------
  app.use("*", async (c, next) => {
    const slug = extractSandboxSlugFromHost(c.req.header("host"));
    if (slug) {
      return handleSandboxReverseProxy(c.req.raw, slug, configStore, config.sandboxCtlScript);
    }
    if (c.req.header("host")?.split(":")[0].toLowerCase() === "oc.jaggi.xyz" && c.req.path === "/") {
      return c.redirect(`${config.publicUrl}/sandboxes`, 302);
    }
    await next();
  });

  app.get("/healthz", (c) => {
    const upstreams = configStore.listUpstreams().length;
    const sandboxes = configStore.listProjects().length;
    return c.json({ ok: true, service: "warden", upstreams, sandboxes });
  });

  // OAuth discovery ----------------------------------------------------------
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(config)));
  app.get("/.well-known/oauth-authorization-server", async (c) => {
    const meta = await authServerMetadata(config);
    return meta ? c.json(meta) : c.json({ error: "no authorization server configured" }, 404);
  });

  // MCP Streamable HTTP ------------------------------------------------------
  app.all("/mcp", async (c) => handleMcp(c.req.raw, runtime));

  // Agent LLM Cost & Subscription Quota Proxy (/llm/:provider/*) -------------
  app.all("/llm/:provider/*", async (c) => {
    const provider = c.req.param("provider");
    const prefix = `/llm/${provider}/`;
    const subpath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    return handleLlmProxy(c.req.raw, provider, subpath, config, configStore, secrets, notifier);
  });

  // Zero-Secret Sandbox Credential Brokers (/aws-creds, /git-creds) ----------
  app.get("/aws-creds", async (c) =>
    handleAwsCredsBroker(c.req.raw, configStore, baseDeps.store, secrets, notifier)
  );
  app.get("/git-creds", async (c) => handleGitCredsBroker(c.req.raw, configStore, secrets));

  // Admin API ----------------------------------------------------------------
  registerApi(app, config, db, notifier);

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
 * Background jobs:
 *   1. Pin any seeded/configured upstream that has no baseline yet (fail-closed if unreachable).
 *   2. Re-verify all upstreams' trust baselines every 10 minutes and notify Home Assistant on drift.
 *   3. Sweep idle `auto-stop` OpenCode sandboxes every 5 minutes.
 */
function startBackgroundTasks(config: GatewayConfig, db: Database.Database, notifier: HermesBridge): void {
  const deps = buildDeps(config, db, "system", [], notifier);

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

  const trustTimer = setInterval(() => {
    deps.trust.verifyAll().catch(() => undefined);
  }, 10 * 60_000);
  if (typeof trustTimer.unref === "function") {
    trustTimer.unref();
  }

  const idleTimer = setInterval(() => {
    sweepIdleSandboxes(deps.configStore, config.sandboxCtlScript).catch(() => undefined);
  }, 5 * 60_000);
  if (typeof idleTimer.unref === "function") {
    idleTimer.unref();
  }
}

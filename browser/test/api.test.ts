import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";
import { ProfileStore } from "../src/profiles.js";
import { createApp } from "../src/server.js";
import { FakeRegistry, FakeSession, nullLogger, testConfig } from "./helpers.js";

const TOKEN = "test-token";

async function makeApp() {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-api-"));
  const registry = new FakeRegistry();
  const config = testConfig({ novncPath: path.join(dir, "does-not-exist") });
  const artifacts = new ArtifactStore(path.join(dir, "artifacts"));
  await artifacts.init();
  const profiles = new ProfileStore(path.join(dir, "profiles"));
  return { app: createApp({ config, registry, artifacts, profiles, log: nullLogger }), registry, artifacts };
}

function authed(body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("HTTP API", () => {
  it("management + facade endpoints require the bearer token", async () => {
    const { app } = await makeApp();
    for (const [path, init] of [
      ["/api/sessions", {}],
      ["/healthz", {}],
      ["/metrics", {}],
      ["/mcp", { method: "POST", body: "{}" }],
      ["/p/proj/mcp", { method: "POST", body: "{}" }],
    ] as const) {
      const noToken = await app.request(path, init);
      expect(noToken.status, path).toBe(401);
      const badToken = await app.request(path, {
        ...init,
        headers: { authorization: "Bearer wrong" },
      });
      expect(badToken.status, path).toBe(401);
    }
  });

  it("healthz and metrics respond with the token", async () => {
    const { app } = await makeApp();
    const health = await app.request("/healthz", authed());
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const metrics = await app.request("/metrics", authed());
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("browser_pool_slots_total 8");
    expect(text).toContain("browser_sessions{state=\"ready\"}");
    expect(text).toContain("browser_ram_free_bytes");
  });

  it("validates slugs before touching anything", async () => {
    const { app, registry } = await makeApp();
    for (const bad of ["BAD", "x_y", "a b"]) {
      const res = await app.request(`/api/sessions/${encodeURIComponent(bad)}`, authed());
      expect(res.status, bad).toBe(400);
    }
    const facade = await app.request("/p/NOPE/mcp", authed({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(facade.status).toBe(400);
    expect(registry.ensures).toEqual([]);
  });

  it("routes the facade project from X-Warden-Caller with _default fallback", async () => {
    const { app, registry } = await makeApp();
    const call = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    await app.request("/mcp", {
      ...authed(call),
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-warden-caller": "rsearch" },
    });
    expect(registry.ensures).toEqual(["rsearch"]);

    await app.request("/devtools", authed(call));
    expect(registry.ensures).toEqual(["rsearch", "_default"]);

    await app.request("/p/calendar-m365-google-sync/mcp", authed(call));
    expect(registry.ensures).toEqual(["rsearch", "_default", "calendar-m365-google-sync"]);

    const badCaller = await app.request("/mcp", {
      ...authed(call),
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-warden-caller": "BAD!" },
    });
    expect(badCaller.status).toBe(400);
  });

  it("returns 202 for JSON-RPC notifications and error objects for parse failures", async () => {
    const { app } = await makeApp();
    const notification = await app.request("/p/proj/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }),
    });
    expect(notification.status).toBe(202);

    const broken = await app.request("/p/proj/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });
    const body = (await broken.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("serves artifact bytes by content id", async () => {
    const { app, artifacts } = await makeApp();
    await mkdir(artifacts.stagingDir("proj"), { recursive: true });
    await writeFile(path.join(artifacts.stagingDir("proj"), "shot.webp"), "WEBP");
    const [artifact] = await artifacts.capture("proj", "call-1", Date.now() - 5_000);

    const res = await app.request(`/artifacts/${artifact.id}`, authed());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("WEBP");

    expect((await app.request("/artifacts/notanid", authed())).status).toBe(400);
    expect((await app.request("/artifacts/0123456789abcdef", authed())).status).toBe(404);
  });

  it("serves the session picker page and the noVNC placeholder", async () => {
    const { app } = await makeApp();
    const home = await app.request("/", { method: "GET" });
    expect(home.status).toBe(200);
    const homeText = await home.text();
    expect(homeText).toContain("Browser sessions");
    // Fallback UI: explicit takeover controls (opening the viewer never flips the mode).
    expect(homeText).toContain("Take Over");
    expect(homeText).toContain("Release");

    const view = await app.request("/p/proj/view", { method: "GET" });
    expect(view.status).toBe(200);
    const viewText = await view.text();
    expect(viewText).toContain("Take Over");
    expect(viewText).toContain("Release");
    expect(viewText).toContain("/api/sessions/"); // calls the mode API
    expect(viewText).toContain("reconnect"); // and reconnects the noVNC WS afterwards

    const novnc = await app.request("/novnc/vnc.html", { method: "GET" });
    expect(novnc.status).toBe(200);
    expect(await novnc.text()).toContain("noVNC");

    const vncRedirect = await app.request("/p/proj/vnc", { method: "GET" });
    expect(vncRedirect.status).toBe(302);
    expect(vncRedirect.headers.get("location")).toContain("/novnc/vnc.html?path=p/proj/vnc");
  });

  it("mode + profile + session management endpoints validate and dispatch", async () => {
    const session = new FakeSession("proj");
    const { app, registry } = await makeApp();
    registry.session = session;

    const list = await app.request("/api/sessions", authed());
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(1);
    // viewers = passive watchers, takeoverViewers = interactive connections.
    expect(body.sessions[0]).toMatchObject({ viewers: 0, takeoverViewers: 0 });

    const badMode = await app.request("/api/sessions/proj/mode", {
      ...authed({ mode: "hacker" }),
    });
    expect(badMode.status).toBe(400);

    const mode = await app.request("/api/sessions/proj/mode", authed({ mode: "operator" }));
    expect(mode.status).toBe(200);
    expect(session.mode).toBe("operator");

    const badProfile = await app.request("/api/sessions/proj/profile", authed({ action: "steal", name: "x" }));
    expect(badProfile.status).toBe(400);

    const badName = await app.request("/api/sessions/proj/profile", authed({ action: "attach", name: "../etc" }));
    expect(badName.status).toBe(400);
  });
});

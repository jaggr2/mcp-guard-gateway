import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "../src/server.js";
import { TAKEOVER_ERROR } from "../src/machine.js";
import { RegistryError } from "../src/registry.js";
import { ArtifactStore } from "../src/artifacts.js";
import { ProfileStore } from "../src/profiles.js";
import { FakeRegistry, FakeSession, nullLogger, testConfig } from "./helpers.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

async function makeApp(session: FakeSession | null): Promise<{ app: Hono; registry: FakeRegistry }> {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-mg-"));
  const registry = new FakeRegistry();
  registry.session = session;
  const config = testConfig();
  const artifacts = new ArtifactStore(path.join(dir, "artifacts"));
  await artifacts.init();
  const profiles = new ProfileStore(path.join(dir, "profiles"));
  return { app: createApp({ config, registry, artifacts, profiles, log: nullLogger }), registry };
}

const TOKEN = "test-token";

describe("mode gate (operator takeover)", () => {
  it("rejects tools/call with a clean error result while in operator mode", async () => {
    const session = new FakeSession("proj", "ready", "operator");
    const { app } = await makeApp(session);
    const res = await app.request("/p/proj/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "browser_navigate" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(TAKEOVER_ERROR);
    expect(session.rpcCalls).toHaveLength(0); // nothing forwarded to the child
  });

  it("rejects non-tools/call methods with a JSON-RPC error in operator mode", async () => {
    const session = new FakeSession("proj", "ready", "operator");
    const { app } = await makeApp(session);
    const res = await app.request("/p/proj/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe(TAKEOVER_ERROR);
  });

  it("forwards calls in agent mode and after release", async () => {
    const session = new FakeSession("proj", "ready", "agent");
    session.rpcImpl = (_kind, message) =>
      Promise.resolve({ jsonrpc: "2.0", id: message.id ?? null, result: { forwarded: true } });
    const { app } = await makeApp(session);
    const res = await app.request("/p/proj/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_snapshot" } }),
    });
    const body = (await res.json()) as { result: { forwarded: boolean } };
    expect(body.result.forwarded).toBe(true);
    expect(session.rpcCalls).toHaveLength(1);
  });

  it("operator mode rejects agent calls but management API still works", async () => {
    const session = new FakeSession("proj", "ready", "operator");
    const { app } = await makeApp(session);
    const modeRes = await app.request("/api/sessions/proj/mode", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "agent" }),
    });
    expect(modeRes.status).toBe(200);
  });

  it("boot failures surface as clean JSON-RPC errors, never hangs", async () => {
    const { app, registry } = await makeApp(null);
    registry.ensureError = new RegistryError("boot failed for proj: readiness timeout", 503);
    const res = await app.request("/p/proj/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/boot failed/);
  });
});

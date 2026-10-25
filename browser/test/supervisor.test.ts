import { describe, expect, it } from "vitest";
import { SessionSupervisor } from "../src/supervisor.js";
import { slotFor } from "../src/pool.js";
import { TAKEOVER_ERROR } from "../src/machine.js";
import type { JsonRpcMessage } from "../src/rpc.js";
import { MockPorts, MockSpawner, nullLogger, testConfig, type MockSpawnerOptions } from "./helpers.js";

function makeSupervisor(spawnerOpts: MockSpawnerOptions = {}) {
  const spawner = new MockSpawner(spawnerOpts);
  const ports = new MockPorts();
  const config = testConfig();
  const sup = new SessionSupervisor(
    { spawner, ports, config, log: nullLogger, artifactCount: () => 0 },
    "proj",
    slotFor(1),
  );
  return { sup, spawner, ports, config };
}

describe("SessionSupervisor boot", () => {
  it("spawns the tree in order and passes the readiness gate into ready", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();

    expect(sup.state).toBe("ready");
    expect(sup.mode).toBe("agent");
    expect(sup.bootCount).toBe(1);
    expect(spawner.spawnFiles).toEqual([
      "Xvfb",
      "chromium",
      "x11vnc",
      "x11vnc",
      "websockify",
      "npx",
      "npx",
    ]);

    // Static pool mapping: display :1 ↔ CDP 9221 ↔ vnc 5901 ↔ ws 6081 ↔ input 6091.
    const chromium = spawner.find("chromium")[0];
    expect(chromium.spec.args).toContain("--remote-debugging-port=9221");
    expect(chromium.spec.args).toContain("--remote-debugging-address=127.0.0.1");
    expect(chromium.spec.env).toMatchObject({ DISPLAY: ":1" });

    // Two x11vnc processes on the same display: view-only (input gated off)
    // and interactive (operator takeover input).
    const vncView = spawner.find("x11vnc")[0];
    expect(vncView.spec.args).toContain("-viewonly");
    expect(vncView.spec.args).toContain("-rfbport");
    expect(vncView.spec.args[vncView.spec.args.indexOf("-rfbport") + 1]).toBe("5901");
    const vncInput = spawner.find("x11vnc")[1];
    expect(vncInput.spec.args).not.toContain("-viewonly");
    expect(vncInput.spec.args[vncInput.spec.args.indexOf("-rfbport") + 1]).toBe("6091");

    const playwright = spawner.find("npx")[0];
    expect(playwright.spec.args).toContain("@playwright/mcp");
    expect(playwright.spec.args.join(" ")).toContain("--cdp-endpoint=http://127.0.0.1:9221");
    const devtools = spawner.find("npx")[1];
    expect(devtools.spec.args).toContain("chrome-devtools-mcp");
    expect(devtools.spec.args.join(" ")).toContain("--browserUrl=http://127.0.0.1:9221");
  });

  it("boot is refused while already ready and after teardown can boot again", async () => {
    const { sup } = makeSupervisor();
    await sup.boot();
    await expect(sup.boot()).resolves.toBeUndefined(); // idempotent
    await sup.teardown();
    expect(sup.state).toBe("stopped");
    await sup.boot();
    expect(sup.state).toBe("ready");
  });

  it("stuck booting (no CDP): kill partial tree, retry once, then error", async () => {
    const spawner = new MockSpawner();
    spawner.onSpawn = (proc) => {
      if (proc.spec.file === "chromium") proc.exit(0, null); // dead on arrival
    };
    const ports = new MockPorts();
    const config = testConfig();
    const supervisor = new SessionSupervisor(
      { spawner, ports, config, log: nullLogger, artifactCount: () => 0 },
      "proj",
      slotFor(1),
    );
    await expect(supervisor.boot()).rejects.toThrow();
    expect(supervisor.state).toBe("error");
    // Chromium dies before the MCP children spawn: 2 attempts × 5 processes.
    expect(spawner.spawnFiles).toHaveLength(10);
    // error state refuses further boots until DELETE + POST (teardown)
    await expect(supervisor.boot()).rejects.toThrow(/error state/);
  });

  it("crash policy: error in-flight calls, auto-reboot once, next call works", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();

    spawner.autoRespond = false;
    const inflight: Promise<JsonRpcMessage | null> = sup.rpc("playwright", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "browser_navigate" },
    });

    spawner.autoRespond = true; // the auto-reboot must complete its handshakes
    await sup.handleChromiumExit({ code: 1, signal: null });

    const response = await inflight;
    expect(response?.error?.message).toMatch(/browser crashed/);
    expect(sup.state).toBe("ready"); // auto-rebooted
    expect(sup.crashCount).toBe(1);
    expect(spawner.spawnFiles.filter((f) => f === "chromium")).toHaveLength(2);

    spawner.autoRespond = true;
    const ok = await sup.rpc("playwright", { jsonrpc: "2.0", id: 6, method: "tools/list" });
    expect(ok?.result).toBeDefined();
    expect(ok?.error).toBeUndefined();
  });

  it("chromium death via process exit wires into the crash policy", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();
    spawner.find("chromium")[0].exit(1, null);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sup.state).toBe("ready");
    expect(sup.crashCount).toBe(1);
  });

  it("crash loop >3 in 5 min -> error state, facade gets a clean error", async () => {
    const { sup } = makeSupervisor();
    await sup.boot();
    for (let i = 0; i < 3; i++) {
      await sup.handleChromiumExit({ code: 1, signal: null });
      expect(sup.state).toBe("ready");
    }
    await sup.handleChromiumExit({ code: 1, signal: null });
    expect(sup.state).toBe("error");

    const resp = await sup.rpc("playwright", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(resp?.error?.message).toMatch(/error state/);
    await expect(sup.boot()).rejects.toThrow(/error state/);
  });

  it("shutdown order: MCP children → Chromium (SIGKILL after grace) → both x11vnc → websockify → Xvfb", async () => {
    const { sup, spawner } = makeSupervisor({ exitOnKill: false });
    await sup.boot();
    await sup.teardown();

    const order = [...new Set(spawner.killLog.map((k) => k.file))];
    expect(order).toEqual(["npx", "chromium", "x11vnc", "websockify", "Xvfb"]);
    // Both x11vnc processes (view-only + interactive) are stopped where the
    // single one used to be: after Chromium, before websockify/Xvfb.
    expect(spawner.killLog.filter((k) => k.signal === "SIGTERM").map((k) => k.file)).toEqual([
      "npx",
      "npx",
      "chromium",
      "x11vnc",
      "x11vnc",
      "websockify",
      "Xvfb",
    ]);
    expect(spawner.killLog.filter((k) => k.file === "chromium").map((k) => k.signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(sup.state).toBe("stopped");
  });

  it("restarts a dead MCP child and fails only its in-flight calls", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();

    spawner.autoRespond = false;
    const inflight = sup.rpc("playwright", {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "browser_click" },
    });
    spawner.autoRespond = true;
    spawner.find("npx")[0].exit(1, null); // playwright child dies

    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await inflight;
    expect(response?.error?.message).toMatch(/closed/);
    expect(spawner.find("npx").length).toBe(3); // 2 original + 1 restarted
    expect(sup.state).toBe("ready"); // only the child restarted, not the session
  });

  it("RAM watchdog restarts the session over the limit", async () => {
    const { sup, ports } = makeSupervisor();
    await sup.boot();
    ports.rss = 2 * 1024 ** 3; // > 1.5 GB watchdog
    await sup.checkWatchdog();
    expect(sup.state).toBe("ready");
    expect(sup.timeline.some((e) => e.type === "ram_watchdog")).toBe(true);
    expect(sup.crashCount).toBe(0); // restart, not a crash
  });
});

describe("SessionSupervisor facade semantics", () => {
  it("synthesizes initialize from the cached child handshake (never forwarded)", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();
    const handshakes = spawner.initializeCount; // one per MCP child
    expect(handshakes).toBe(2);

    const resp = await sup.rpc("playwright", {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "warden" } },
    });
    expect(resp?.result).toMatchObject({ protocolVersion: "2025-06-18" });
    expect(spawner.initializeCount).toBe(handshakes);
  });

  it("forwards tools/list and tools/call verbatim over stdio framing", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();
    const resp = await sup.rpc("devtools", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "take_screenshot", arguments: { uid: "x" } },
    });
    expect(resp?.result).toMatchObject({ echoed: "tools/call" });
    const child = spawner.find("npx")[1];
    const last = JSON.parse(child.written[child.written.length - 1]) as JsonRpcMessage;
    expect(last.method).toBe("tools/call");
    expect(last.params).toEqual({ name: "take_screenshot", arguments: { uid: "x" } });
  });

  it("operator mode: tool calls get the takeover error result, notifications are dropped", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();
    sup.takeover("vnc viewer connected");
    expect(sup.mode).toBe("operator");

    const call = await sup.rpc("playwright", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_snapshot" },
    });
    const result = call?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(TAKEOVER_ERROR);

    const list = await sup.rpc("playwright", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list?.error?.message).toBe(TAKEOVER_ERROR);

    const notification = await sup.rpc("playwright", { jsonrpc: "2.0", method: "notifications/cancelled" });
    expect(notification).toBeNull();

    sup.release("api");
    expect(sup.mode).toBe("agent");
    const after = await sup.rpc("playwright", { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(after?.result).toBeDefined();
  });

  it("notifications in agent mode are forwarded without a response", async () => {
    const { sup, spawner } = makeSupervisor();
    await sup.boot();
    const resp = await sup.rpc("playwright", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: { x: 1 },
    });
    expect(resp).toBeNull();
    const child = spawner.find("npx")[0];
    const last = JSON.parse(child.written[child.written.length - 1]) as JsonRpcMessage;
    expect(last.method).toBe("notifications/initialized");
    expect(last.id).toBeUndefined();
  });
});

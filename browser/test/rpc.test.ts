import { describe, expect, it } from "vitest";
import { channelFromProcess, McpChild, RpcError, StdioJsonRpcClient } from "../src/rpc.js";
import { FakeChannel, FakeProcess, MockSpawner } from "./helpers.js";

describe("stdio newline-delimited JSON-RPC framing", () => {
  it("reassembles lines split across chunks and splits multiple lines per chunk", () => {
    const proc = new FakeProcess({ file: "child", args: [] });
    const channel = channelFromProcess(proc);
    const lines: string[] = [];
    channel.onLine((line) => lines.push(line));

    proc.emitChunk('{"a":1}\n{"b');
    proc.emitChunk('":2}\n\n{"c":3}');
    proc.emitChunk("\n");

    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("writeLine terminates with a newline", () => {
    const proc = new FakeProcess({ file: "child", args: [] });
    const channel = channelFromProcess(proc);
    channel.writeLine('{"x":1}');
    expect(proc.written).toEqual(['{"x":1}\n']);
  });
});

describe("StdioJsonRpcClient", () => {
  it("matches responses to requests by id, even out of order", async () => {
    const channel = new FakeChannel();
    const client = new StdioJsonRpcClient(channel, { requestTimeoutMs: 5_000 });

    const first = client.request("alpha");
    const second = client.request("beta");
    const ids = channel.written.map((line) => (JSON.parse(line) as { id: number }).id);
    expect(ids).toEqual([1, 2]);

    channel.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "B" }));
    channel.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "A" }));

    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
  });

  it("rejects with RpcError when the child returns an error object", async () => {
    const channel = new FakeChannel();
    const client = new StdioJsonRpcClient(channel);
    const pending = client.request("boom");
    channel.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }));
    const err = await pending.catch((e: RpcError) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(-32601);
  });

  it("times out requests that never get a response", async () => {
    const channel = new FakeChannel();
    const client = new StdioJsonRpcClient(channel, { name: "slow-child" });
    await expect(client.request("slow", {}, 15)).rejects.toThrow(/timeout after 15ms/);
  });

  it("failAll rejects in-flight requests (crash policy)", async () => {
    const channel = new FakeChannel();
    const client = new StdioJsonRpcClient(channel);
    const pending = client.request("tools/call", { name: "browser_navigate" }, 5_000);
    client.failAll("browser crashed — retry after reboot");
    await expect(pending).rejects.toThrow(/browser crashed/);
  });

  it("child close rejects pending requests and refuses new ones", async () => {
    const channel = new FakeChannel();
    const client = new StdioJsonRpcClient(channel, { name: "child" });
    const pending = client.request("tools/list", {}, 5_000);
    channel.close();
    await expect(pending).rejects.toThrow(/child closed/);
    await expect(client.request("tools/list")).rejects.toThrow(/child closed/);
    expect(client.closed).toBe(true);
  });

  it("notifications are sent without an id", () => {
    const channel = new FakeChannel();
    const client = new StdioJsonRpcClient(channel);
    client.notify("notifications/initialized");
    expect(channel.written).toHaveLength(1);
    expect(JSON.parse(channel.written[0])).not.toHaveProperty("id");
  });
});

describe("McpChild handshake + cached initialize", () => {
  const spec = {
    file: "npx",
    args: ["--yes", "@playwright/mcp", "--isolated", "--cdp-endpoint=http://127.0.0.1:9221"],
  };

  it("performs the real initialize handshake exactly once at spawn", async () => {
    const spawner = new MockSpawner();
    const child = await McpChild.start(spawner, spec, { name: "playwright" });
    expect(spawner.initializeCount).toBe(1);
    expect(child.initializeResult).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "@playwright/mcp" },
    });

    // Later tool calls are forwarded verbatim.
    const result = (await child.call("tools/list", {})) as { echoed: string };
    expect(result.echoed).toBe("tools/list");
    expect(spawner.initializeCount).toBe(1); // no second initialize
  });

  it("caches the handshake so client initialize can be synthesized", async () => {
    const spawner = new MockSpawner();
    const child = await McpChild.start(spawner, spec, { name: "playwright" });
    // The facade would answer a client `initialize` from this cache — the child
    // must never see a second initialize request.
    expect(child.initializeResult).toBeDefined();
    expect(spawner.initializeCount).toBe(1);
  });

  it("shutdown kills the child (SIGTERM)", async () => {
    const spawner = new MockSpawner();
    const child = await McpChild.start(spawner, spec, { name: "playwright" });
    await child.shutdown(5);
    expect(spawner.killLog).toEqual([{ file: "npx", signal: "SIGTERM" }]);
    expect(child.closed).toBe(true);
  });
});

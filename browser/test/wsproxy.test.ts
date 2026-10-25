import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createUpgradeHandler, type RfbConnection } from "../src/wsproxy.js";
import { FakeRegistry, FakeSession, nullLogger } from "./helpers.js";

class FakeRfb implements RfbConnection {
  readonly written: Buffer[] = [];
  private readonly dataHandlers: Array<(chunk: Buffer) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  destroyed = false;

  write(data: Buffer): void {
    this.written.push(data);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emitClose();
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  emit(chunk: Buffer): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }

  emitClose(): void {
    for (const handler of this.closeHandlers) handler();
  }
}

function fakeConnector() {
  const calls: number[] = [];
  const conns: FakeRfb[] = [];
  return {
    calls,
    conns,
    connect: (port: number): Promise<RfbConnection> => {
      calls.push(port);
      const conn = new FakeRfb();
      conns.push(conn);
      return Promise.resolve(conn);
    },
  };
}

async function startProxy(session: FakeSession, connector: ReturnType<typeof fakeConnector>) {
  const registry = new FakeRegistry();
  registry.session = session;
  const handler = createUpgradeHandler({ registry, log: nullLogger, connectRfb: connector.connect });
  const server: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/p/${session.project}/vnc`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function connectClient(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(cond()).toBe(true);
}

const openClients: WebSocket[] = [];
let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;

afterEach(async () => {
  for (const ws of openClients.splice(0)) ws.terminate();
  await proxy?.close();
  proxy = null;
});

async function open(session: FakeSession, connector: ReturnType<typeof fakeConnector>): Promise<WebSocket> {
  proxy = await startProxy(session, connector);
  const ws = await connectClient(proxy.url);
  openClients.push(ws);
  return ws;
}

describe("WS /p/:project/vnc routes by session mode", () => {
  it("connects to the view-only x11vnc in agent mode and does NOT flip the mode", async () => {
    const session = new FakeSession("proj", "ready", "agent");
    const connector = fakeConnector();
    const ws = await open(session, connector);

    await until(() => connector.calls.length === 1);
    expect(connector.calls).toEqual([5901]); // view-only RFB port (input gated off)
    expect(session.mode).toBe("agent"); // watching is passive — no takeover
    expect(session.takeovers).toEqual([]);
    expect(session.watcherCount).toBe(1);
    expect(session.takeoverViewerCount).toBe(0);

    ws.close();
    await until(() => session.watcherCount === 0);
  });

  it("connects to the interactive x11vnc in operator mode and counts a takeover viewer", async () => {
    const session = new FakeSession("proj", "ready", "operator");
    const connector = fakeConnector();
    await open(session, connector);

    await until(() => connector.calls.length === 1);
    expect(connector.calls).toEqual([6091]); // interactive RFB port
    expect(session.watcherCount).toBe(0);
    expect(session.takeoverViewerCount).toBe(1);
  });

  it("takeover flips the route for new connections, release flips it back", async () => {
    const session = new FakeSession("proj", "ready", "agent");
    const connector = fakeConnector();
    await open(session, connector);
    await until(() => connector.calls.length === 1);
    expect(connector.calls).toEqual([5901]);

    // Explicit takeover (what POST /api/sessions/:slug/mode does).
    session.takeover("api");
    await open(session, connector);
    await until(() => connector.calls.length === 2);
    expect(connector.calls).toEqual([5901, 6091]); // new connection routes interactive
    expect(session.takeoverViewerCount).toBe(1);
    expect(session.watcherCount).toBe(1); // the pre-takeover watcher stays a watcher

    // Release back to the agent; reconnects must route view-only again.
    session.release("api");
    await open(session, connector);
    await until(() => connector.calls.length === 3);
    expect(connector.calls).toEqual([5901, 6091, 5901]);
    expect(session.watcherCount).toBe(2);
    expect(session.takeoverViewerCount).toBe(1);
  });

  it("relays raw RFB bytes both ways on the picked port", async () => {
    const session = new FakeSession("proj", "ready", "agent");
    const connector = fakeConnector();
    const ws = await open(session, connector);
    await until(() => connector.conns.length === 1);
    const rfb = connector.conns[0];

    const got: Buffer[] = [];
    ws.on("message", (data) => got.push(Buffer.from(data as Buffer)));
    rfb.emit(Buffer.from("RFB 003.008\n"));
    await until(() => got.length === 1);
    expect(got[0].toString()).toBe("RFB 003.008\n");

    ws.send(Buffer.from("input-bytes"));
    await until(() => rfb.written.length === 1);
    expect(rfb.written[0].toString()).toBe("input-bytes");
  });
});

import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import type { RawTransport } from "../src/cdp.js";
import type { SupervisorPorts } from "../src/host.js";
import { nullLogger } from "../src/logger.js";
import type { SessionMode, SessionState } from "../src/machine.js";
import type {
  McpKind,
  MetricsSnapshot,
  SessionHandle,
  SessionInfo,
  SessionRegistry,
} from "../src/registry.js";
import type { JsonRpcMessage, StdioChannel } from "../src/rpc.js";
import type {
  ExitInfo,
  ProcessSpawner,
  ReadableLike,
  SpawnedProcess,
  SpawnSpec,
  WritableLike,
} from "../src/spawner.js";
import type { ViewerConn } from "../src/screencast.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ ORCHESTRATOR_TOKEN: "test-token" }),
    shutdownGraceMs: 5,
    ...overrides,
  };
}

let pidCounter = 1000;

/** In-memory SpawnedProcess with an optional scripted JSON-RPC responder. */
export class FakeProcess implements SpawnedProcess {
  readonly pid: number | undefined = pidCounter++;
  readonly written: string[] = [];
  exitInfo: ExitInfo | null = null;
  autoExitOnKill = true;
  lineHandler: ((line: string) => void) | null = null;
  onKill: ((signal: string) => void) | null = null;
  private readonly exitHandlers: Array<(info: ExitInfo) => void> = [];
  private readonly dataHandlers: Array<(chunk: string) => void> = [];

  constructor(readonly spec: SpawnSpec) {}

  readonly stdin: WritableLike = {
    write: (data: string) => {
      this.written.push(data);
      for (const line of data.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.lineHandler?.(trimmed);
      }
      return true;
    },
    end: () => undefined,
  };

  readonly stdout: ReadableLike = {
    setEncoding: () => this.stdout,
    on: (_event, listener) => {
      this.dataHandlers.push(listener);
      return this.stdout;
    },
  };

  readonly stderr: ReadableLike = {
    setEncoding: () => this.stderr,
    on: () => this.stderr,
  };

  emitChunk(chunk: string): void {
    for (const handler of this.dataHandlers) handler(chunk);
  }

  respond(obj: unknown): void {
    this.emitChunk(`${JSON.stringify(obj)}\n`);
  }

  onExit(cb: (info: ExitInfo) => void): void {
    this.exitHandlers.push(cb);
    if (this.exitInfo) cb(this.exitInfo);
  }

  exit(code: number | null = 0, signal: string | null = null): void {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal };
    for (const handler of this.exitHandlers) handler(this.exitInfo);
  }

  kill(signal = "SIGTERM"): boolean {
    this.onKill?.(signal);
    if (this.autoExitOnKill) this.exit(0, signal);
    return true;
  }
}

export interface MockSpawnerOptions {
  autoRespond?: boolean;
  /** When false, kill() records but the process does not exit (SIGKILL assertions). */
  exitOnKill?: boolean;
}

/** Spawner double: logs specs + kills and auto-answers MCP handshakes. */
export class MockSpawner implements ProcessSpawner {
  readonly spawned: FakeProcess[] = [];
  readonly killLog: Array<{ file: string; signal: string }> = [];
  initializeCount = 0;
  autoRespond: boolean;
  exitOnKill: boolean;
  onSpawn: ((proc: FakeProcess) => void) | null = null;

  constructor(opts: MockSpawnerOptions = {}) {
    this.autoRespond = opts.autoRespond ?? true;
    this.exitOnKill = opts.exitOnKill ?? true;
  }

  spawn(spec: SpawnSpec): SpawnedProcess {
    const proc = new FakeProcess(spec);
    proc.autoExitOnKill = this.exitOnKill;
    proc.onKill = (signal) => this.killLog.push({ file: spec.file, signal });
    proc.lineHandler = (line) => this.handleLine(proc, line);
    this.spawned.push(proc);
    this.onSpawn?.(proc);
    return proc;
  }

  handleLine(proc: FakeProcess, line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (msg.method === "initialize") {
      this.initializeCount++;
      if (this.autoRespond) {
        proc.respond({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: proc.spec.args[1] ?? "mock-mcp", version: "0.0.1" },
          },
        });
      }
    } else if (msg.id !== undefined) {
      if (this.autoRespond) {
        proc.respond({
          jsonrpc: "2.0",
          id: msg.id,
          result: { echoed: msg.method, params: msg.params ?? null },
        });
      }
    }
  }

  find(file: string): FakeProcess[] {
    return this.spawned.filter((p) => p.spec.file === file);
  }

  get spawnFiles(): string[] {
    return this.spawned.map((p) => p.spec.file);
  }
}

export class MockPorts implements SupervisorPorts {
  time = 1_000_000;
  cdpReady = true;
  listening = new Set<number>([5901, 6081, 5902, 6082]);
  freeRam = 8 * 1024 ** 3;
  rss = 100 * 1024 ** 2;
  readonly sleepLog: number[] = [];

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.sleepLog.push(ms);
    this.time += ms;
    await Promise.resolve();
  }

  fetchJson(_url: string, _timeoutMs: number): Promise<unknown | null> {
    return Promise.resolve(this.cdpReady ? { webSocketDebuggerUrl: "ws://mock/devtools/browser/x" } : null);
  }

  openWebSocket(_url: string): Promise<RawTransport> {
    return Promise.reject(new Error("openWebSocket is not mocked"));
  }

  isPortListening(port: number): Promise<boolean> {
    return Promise.resolve(this.listening.has(port));
  }

  freeRamBytes(): Promise<number> {
    return Promise.resolve(this.freeRam);
  }

  processRssBytes(_pid: number): Promise<number | null> {
    return Promise.resolve(this.rss);
  }
}

export class FakeChannel implements StdioChannel {
  readonly written: string[] = [];
  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  writeLine(line: string): void {
    this.written.push(line);
  }

  onLine(cb: (line: string) => void): void {
    this.lineHandlers.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
  }

  pushLine(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }

  close(): void {
    for (const handler of this.closeHandlers) handler();
  }
}

export function fakeViewer(): ViewerConn & { sent: unknown[]; closed: boolean } {
  const sent: unknown[] = [];
  const closeHandlers: Array<() => void> = [];
  const conn = {
    sent,
    closed: false,
    sendJson(obj: unknown) {
      sent.push(obj);
    },
    sendBinary(_data: Buffer, cb?: () => void) {
      cb?.();
    },
    close() {
      conn.closed = true;
      for (const handler of closeHandlers) handler();
    },
    onClose(cb: () => void) {
      closeHandlers.push(cb);
    },
  };
  return conn;
}

export class FakeSession implements SessionHandle {
  readonly rpcCalls: Array<{ kind: McpKind; message: JsonRpcMessage }> = [];
  viewerCount = 0;
  takeovers: string[] = [];
  releases: string[] = [];
  rpcImpl: (kind: McpKind, message: JsonRpcMessage) => Promise<JsonRpcMessage | null> = (
    _kind,
    message,
  ) =>
    // Mirrors the supervisor semantics: notifications get no response.
    message.id === undefined
      ? Promise.resolve(null)
      : Promise.resolve({ jsonrpc: "2.0", id: message.id, result: { ok: true } });

  constructor(
    readonly project: string,
    public state: SessionState = "ready",
    public mode: SessionMode = "agent",
    public info: Partial<SessionInfo> = {},
  ) {}

  get vncPort(): number {
    return 5901;
  }

  get wsPort(): number {
    return 6081;
  }

  rpc(kind: McpKind, message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    this.rpcCalls.push({ kind, message });
    return this.rpcImpl(kind, message);
  }

  viewerOpened(): void {
    this.viewerCount++;
  }

  viewerClosed(): void {
    this.viewerCount--;
  }

  takeover(reason: string): void {
    this.takeovers.push(reason);
    this.mode = "operator";
  }

  release(reason: string): void {
    this.releases.push(reason);
    this.mode = "agent";
  }

  addCastViewer(_conn: ViewerConn): void {
    /* not asserted in tests */
  }

  removeCastViewer(_conn: ViewerConn): void {
    /* not asserted in tests */
  }

  toInfo(): Promise<SessionInfo> {
    return Promise.resolve(this.infoOf(false));
  }

  infoOf(withTimeline: boolean): SessionInfo {
    return {
      project: this.project,
      state: this.state,
      mode: this.mode,
      display: ":1",
      cdpPort: 9221,
      vncPort: 5901,
      wsPort: 6081,
      currentUrl: null,
      title: null,
      startedAt: 0,
      lastActivityAt: 0,
      viewers: this.viewerCount,
      bootCount: 1,
      crashCount: 0,
      ramBytes: 1000,
      artifactCount: 0,
      profile: null,
      ...(withTimeline ? { timeline: [] } : {}),
      ...this.info,
    };
  }
}

export class FakeRegistry implements SessionRegistry {
  readonly ensures: string[] = [];
  session: FakeSession | null = null;
  ensureError: Error | null = null;

  ensure(project: string): Promise<SessionHandle> {
    this.ensures.push(project);
    if (this.ensureError) return Promise.reject(this.ensureError);
    if (!this.session) this.session = new FakeSession(project);
    return Promise.resolve(this.session);
  }

  get(project: string): SessionHandle | undefined {
    return this.session?.project === project ? this.session : undefined;
  }

  list(): Promise<SessionInfo[]> {
    return Promise.resolve(this.session ? [this.session.infoOf(false)] : []);
  }

  info(project: string): Promise<SessionInfo | null> {
    return Promise.resolve(this.session?.project === project ? this.session.infoOf(true) : null);
  }

  teardown(): Promise<void> {
    return Promise.resolve();
  }

  setMode(project: string, mode: SessionMode): Promise<SessionInfo> {
    if (!this.session) return Promise.reject(new Error("no session"));
    this.session.mode = mode;
    return Promise.resolve(this.session.infoOf(false));
  }

  profileAction(): Promise<SessionInfo> {
    return Promise.resolve(this.session?.infoOf(false) ?? ({} as SessionInfo));
  }

  metrics(): Promise<MetricsSnapshot> {
    return Promise.resolve({
      poolTotal: 8,
      poolUsed: 0,
      sessionsByState: { stopped: 0, booting: 0, ready: 0, error: 0 },
      bootsTotal: 0,
      crashesTotal: 0,
      screencastFramesTotal: 0,
      freeRamBytes: 1,
    });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export { nullLogger };

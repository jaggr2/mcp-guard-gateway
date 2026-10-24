import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "./config.js";
import type { SupervisorPorts } from "./host.js";
import type { Logger } from "./logger.js";
import {
  canAcceptToolCalls,
  initialMachine,
  TAKEOVER_ERROR,
  transition,
  type Effect,
  type MachineState,
  type SessionMode,
  type SessionState,
  type TransitionResult,
} from "./machine.js";
import type { PoolSlot } from "./pool.js";
import type { ProcessSpawner, SpawnedProcess, SpawnSpec } from "./spawner.js";
import { CdpClient } from "./cdp.js";
import { McpChild, type JsonRpcMessage } from "./rpc.js";
import type { McpKind, SessionHandle, SessionInfo, TimelineEvent } from "./registry.js";
import { ScreencastEngine, type ViewerConn } from "./screencast.js";

export interface SupervisorDeps {
  spawner: ProcessSpawner;
  ports: SupervisorPorts;
  config: Config;
  log: Logger;
  artifactCount: (project: string) => number;
}

interface TreeAlive {
  xvfb: boolean;
  chromium: boolean;
  x11vnc: boolean;
  websockify: boolean;
}

/**
 * SessionSupervisor (Part 10.2/10.3): owns one session's process tree
 * (Xvfb → headed Chromium → x11vnc → websockify + two stdio MCP children),
 * runs the boot readiness gate, the crash policy and the shutdown order, and
 * exposes the stateless facade over its two MCP children.
 */
export class SessionSupervisor implements SessionHandle {
  private machine: MachineState = initialMachine();
  private procs: Partial<Record<"xvfb" | "chromium" | "x11vnc" | "websockify", SpawnedProcess>> = {};
  private children: Partial<Record<McpKind, McpChild>> = {};
  private treeAlive: TreeAlive = { xvfb: false, chromium: false, x11vnc: false, websockify: false };
  private generation = 0;
  private shuttingDown = false;
  private bootPromise: Promise<void> | null = null;

  readonly timeline: TimelineEvent[] = [];
  bootCount = 0;
  crashCount = 0;
  startedAt: number | null = null;
  lastActivityAt: number;
  lastViewerAt = 0;
  viewerCount = 0;
  profileName: string | null = null;

  private userDataDirOverride: string | null = null;
  private screencast: ScreencastEngine | null = null;

  constructor(
    private readonly deps: SupervisorDeps,
    readonly project: string,
    readonly slot: PoolSlot,
  ) {
    this.lastActivityAt = deps.ports.now();
    this.event("created", `display ${slot.display}`);
  }

  // ------------------------------------------------------------------ state

  get state(): SessionState {
    return this.machine.state;
  }

  get mode(): SessionMode {
    return this.machine.mode;
  }

  get vncPort(): number {
    return this.slot.vncPort;
  }

  get wsPort(): number {
    return this.slot.wsPort;
  }

  get chromiumPid(): number | undefined {
    return this.procs.chromium?.pid;
  }

  get screencastFrames(): number {
    return this.screencast?.frameCount ?? 0;
  }

  private event(type: string, detail?: string): void {
    const entry: TimelineEvent = { ts: this.deps.ports.now(), type };
    if (detail) entry.detail = detail;
    this.timeline.push(entry);
    if (this.timeline.length > 200) this.timeline.splice(0, this.timeline.length - 200);
    this.deps.log.info(`session ${this.project}: ${type}`, detail ? { detail } : {});
  }

  private apply(event: Parameters<typeof transition>[1]): TransitionResult {
    const result = transition(this.machine, event, {
      crashWindowMs: this.deps.config.crashWindowMs,
      crashLimit: this.deps.config.crashLimit,
      maxBootAttempts: 2,
    });
    if (result.ok) this.machine = result.next;
    return result;
  }

  // ------------------------------------------------------------------ specs

  private scratchDir(): string {
    return path.join(os.tmpdir(), "browser-orchestrator", `${this.project}-${this.slot.n}`);
  }

  private profileDir(): string {
    return this.userDataDirOverride ?? path.join(this.scratchDir(), "profile");
  }

  private specXvfb(): SpawnSpec {
    return {
      file: "Xvfb",
      args: [this.slot.display, "-screen", "0", "1280x800x24", "-ac", "-nolisten", "tcp"],
    };
  }

  private specChromium(): SpawnSpec {
    return {
      file: this.deps.config.chromiumBin,
      args: [
        `--remote-debugging-port=${this.slot.cdpPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.profileDir()}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--window-size=1280,800",
        "about:blank",
      ],
      env: { DISPLAY: this.slot.display },
    };
  }

  private specX11vnc(): SpawnSpec {
    return {
      file: "x11vnc",
      args: [
        "-display",
        this.slot.display,
        "-localhost",
        "-rfbport",
        String(this.slot.vncPort),
        "-nopw",
        "-forever",
        "-shared",
        "-quiet",
      ],
    };
  }

  private specWebsockify(): SpawnSpec {
    return {
      file: "websockify",
      args: [`127.0.0.1:${this.slot.wsPort}`, `127.0.0.1:${this.slot.vncPort}`],
    };
  }

  private specPlaywright(): SpawnSpec {
    return {
      file: "npx",
      args: [
        "--yes",
        "@playwright/mcp",
        "--isolated",
        `--cdp-endpoint=http://127.0.0.1:${this.slot.cdpPort}`,
        "--output-dir",
        path.join(this.deps.config.stagingDir, this.project),
      ],
      env: { DISPLAY: this.slot.display },
    };
  }

  private specDevtools(): SpawnSpec {
    return {
      file: "npx",
      args: ["--yes", "chrome-devtools-mcp", `--browserUrl=http://127.0.0.1:${this.slot.cdpPort}`],
      env: { DISPLAY: this.slot.display },
    };
  }

  // ------------------------------------------------------------------- boot

  /** Boot the session and wait for readiness. Idempotent per state machine. */
  boot(): Promise<void> {
    if (this.bootPromise) return this.bootPromise;
    const result = this.apply({ type: "boot" });
    if (!result.ok) {
      return this.machine.state === "ready"
        ? Promise.resolve()
        : Promise.reject(new Error(result.reason ?? "boot refused"));
    }
    this.bootCount++;
    this.event("boot", `attempt ${this.machine.bootAttempts}`);
    this.bootPromise = this.runBootCycle().finally(() => {
      this.bootPromise = null;
    });
    return this.bootPromise;
  }

  private async runBootCycle(): Promise<void> {
    for (;;) {
      try {
        await this.runBootSequence();
        this.apply({ type: "booted" });
        this.startedAt = this.deps.ports.now();
        this.lastActivityAt = this.startedAt;
        this.event("ready", `display ${this.slot.display}`);
        return;
      } catch (err) {
        await this.killTree();
        const result = this.apply({ type: "boot_failed" });
        this.event("boot_failed", String(err));
        if (result.effects.includes("enter_error")) {
          this.event("error", "boot failed twice — manual reset required");
          throw err instanceof Error ? err : new Error(String(err));
        }
        this.event("boot_retry");
      }
    }
  }

  /** Boot readiness gate (Part 10.2): Xvfb → CDP /json/version → vnc/ws ports → MCP handshakes. */
  private async runBootSequence(): Promise<void> {
    const deadline = this.deps.ports.now() + this.deps.config.bootTimeoutMs;
    this.spawnTree();
    await this.sleep(150);
    if (!this.treeAlive.xvfb) throw new Error("Xvfb exited during startup");
    const version = (await this.waitFor(
      async () => {
        if (!this.treeAlive.chromium) throw new Error("chromium exited during startup");
        return this.deps.ports.fetchJson(`http://127.0.0.1:${this.slot.cdpPort}/json/version`, 1_000);
      },
      deadline,
      "chromium CDP /json/version",
    )) as { webSocketDebuggerUrl?: string } | null;
    if (!version) throw new Error("chromium CDP endpoint never answered");
    await this.waitFor(
      async () => {
        const vnc = await this.deps.ports.isPortListening(this.slot.vncPort, "127.0.0.1", 500);
        const ws = await this.deps.ports.isPortListening(this.slot.wsPort, "127.0.0.1", 500);
        return vnc && ws ? true : null;
      },
      deadline,
      "x11vnc/websockify listening",
    );
    await this.spawnChildren(deadline);
  }

  private async waitFor<T>(
    probe: () => Promise<T | null>,
    deadline: number,
    what: string,
  ): Promise<T> {
    for (;;) {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value as T;
      if (this.deps.ports.now() >= deadline) throw new Error(`readiness timeout: ${what}`);
      await this.sleep(150);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await this.deps.ports.sleep(ms);
  }

  private spawnTree(): void {
    const gen = ++this.generation;
    this.shuttingDown = false;
    const alive: TreeAlive = { xvfb: true, chromium: true, x11vnc: true, websockify: true };
    this.treeAlive = alive;

    const xvfb = this.deps.spawner.spawn(this.specXvfb());
    this.procs.xvfb = xvfb;
    xvfb.onExit(() => {
      if (gen === this.generation) alive.xvfb = false;
    });

    const chromium = this.deps.spawner.spawn(this.specChromium());
    this.procs.chromium = chromium;
    chromium.onExit((info) => {
      if (gen !== this.generation) return;
      alive.chromium = false;
      void this.handleChromiumExit(info);
    });

    const x11vnc = this.deps.spawner.spawn(this.specX11vnc());
    this.procs.x11vnc = x11vnc;
    x11vnc.onExit(() => {
      if (gen === this.generation) alive.x11vnc = false;
    });

    const websockify = this.deps.spawner.spawn(this.specWebsockify());
    this.procs.websockify = websockify;
    websockify.onExit(() => {
      if (gen === this.generation) alive.websockify = false;
    });
    this.event("spawn", `xvfb+chromium+x11vnc+websockify on ${this.slot.display}`);
  }

  private async spawnChildren(deadline: number): Promise<void> {
    const remaining = Math.max(1_000, deadline - this.deps.ports.now());
    const playwright = await McpChild.start(this.deps.spawner, this.specPlaywright(), {
      name: "playwright",
      handshakeTimeoutMs: remaining,
      requestTimeoutMs: this.deps.config.requestTimeoutMs,
    });
    this.trackChild("playwright", playwright);
    try {
      const devtools = await McpChild.start(this.deps.spawner, this.specDevtools(), {
        name: "devtools",
        handshakeTimeoutMs: remaining,
        requestTimeoutMs: this.deps.config.requestTimeoutMs,
      });
      this.trackChild("devtools", devtools);
    } catch (err) {
      await playwright.shutdown(this.deps.config.shutdownGraceMs);
      throw err;
    }
  }

  private trackChild(kind: McpKind, child: McpChild): void {
    this.children[kind] = child;
    const gen = this.generation;
    child.onExit(() => {
      // MCP stdio child crash: restart the child; only in-flight calls fail.
      if (this.shuttingDown || gen !== this.generation) return;
      if (this.machine.state !== "ready") return;
      this.event("mcp_child_exit", kind);
      void this.restartChild(kind).catch((err) => {
        this.deps.log.warn("mcp child restart failed", { kind, err: String(err) });
      });
    });
  }

  private async restartChild(kind: McpKind): Promise<McpChild> {
    const spec = kind === "playwright" ? this.specPlaywright() : this.specDevtools();
    const child = await McpChild.start(this.deps.spawner, spec, {
      name: kind,
      handshakeTimeoutMs: 8_000,
      requestTimeoutMs: this.deps.config.requestTimeoutMs,
    });
    this.trackChild(kind, child);
    this.event("mcp_child_restart", kind);
    return child;
  }

  // ----------------------------------------------------------------- death

  /** Chromium crash policy: error in-flight calls, auto-reboot once (Part 10.2). */
  async handleChromiumExit(_info: { code: number | null; signal: string | null }): Promise<void> {
    if (this.shuttingDown) return;
    // Mid-boot deaths are handled by the readiness gate (boot_failed → retry → error).
    if (this.machine.state !== "ready") return;
    this.crashCount++;
    const result = this.apply({ type: "crash", at: this.deps.ports.now() });
    this.event("crash", `chromium exited (crashes in window: ${this.machine.crashes.length})`);
    this.failInflight("browser crashed — retry after reboot");
    await this.killTree();
    if (result.effects.includes("enter_error")) {
      this.event("error", `crash loop (${this.machine.crashes.length} in window) — manual reset required`);
      return;
    }
    this.event("auto_reboot");
    try {
      await this.runBootCycle();
    } catch (err) {
      this.deps.log.error("auto-reboot failed", { project: this.project, err: String(err) });
    }
  }

  /** Chromium RAM watchdog (Part 10.8): restart the session over the limit. */
  async checkWatchdog(): Promise<void> {
    const pid = this.chromiumPid;
    if (!pid || this.machine.state !== "ready") return;
    const rss = await this.deps.ports.processRssBytes(pid);
    if (rss !== null && rss > this.deps.config.chromiumRamLimitBytes) {
      this.event("ram_watchdog", `chromium rss ${rss} > ${this.deps.config.chromiumRamLimitBytes}`);
      await this.restart("ram watchdog");
    }
  }

  /** Full session restart (profile attach/detach, RAM watchdog) without crash accounting. */
  async restart(reason: string): Promise<void> {
    const result = this.apply({ type: "restart" });
    if (!result.ok) return;
    this.event("restart", reason);
    this.failInflight("session restarting — retry");
    await this.killTree();
    try {
      await this.runBootCycle();
    } catch (err) {
      this.deps.log.error("restart failed", { project: this.project, err: String(err) });
    }
  }

  private failInflight(reason: string): void {
    for (const child of Object.values(this.children)) child?.failAll(reason);
  }

  // --------------------------------------------------------------- teardown

  async teardown(): Promise<void> {
    const wasLive = this.machine.state !== "stopped";
    const result = this.apply({ type: "teardown" });
    if (wasLive && result.ok) this.event("teardown");
    this.failInflight("session torn down");
    await this.killTree();
    this.screencast?.removeAllViewers();
    await this.screencast?.stop();
    this.screencast = null;
  }

  /** Shutdown order (Part 10.2): MCP children → Chromium → x11vnc/websockify → Xvfb. */
  private async killTree(): Promise<void> {
    this.shuttingDown = true;
    this.generation++;
    const grace = this.deps.config.shutdownGraceMs;
    const children = [this.children.playwright, this.children.devtools].filter(Boolean) as McpChild[];
    this.children = {};
    await Promise.all(children.map((child) => child.shutdown(grace)));
    await this.killProcess(this.procs.chromium);
    await this.killProcess(this.procs.x11vnc);
    await this.killProcess(this.procs.websockify);
    await this.killProcess(this.procs.xvfb);
    this.procs = {};
    this.shuttingDown = false;
  }

  private async killProcess(proc: SpawnedProcess | undefined): Promise<void> {
    if (!proc) return;
    let exited = false;
    const done = new Promise<void>((resolve) =>
      proc.onExit(() => {
        exited = true;
        resolve();
      }),
    );
    proc.kill("SIGTERM");
    await Promise.race([done, this.sleep(this.deps.config.shutdownGraceMs)]);
    if (!exited) proc.kill("SIGKILL");
  }

  // ------------------------------------------------------------------- mode

  takeover(reason: string): void {
    const result = this.apply({ type: "takeover" });
    if (result.ok) this.event("takeover", reason);
  }

  release(reason: string): void {
    const result = this.apply({ type: "release" });
    if (result.ok) this.event("release", reason);
  }

  viewerOpened(): void {
    this.viewerCount++;
    this.lastViewerAt = this.deps.ports.now();
    this.noteActivity();
  }

  viewerClosed(): void {
    this.viewerCount = Math.max(0, this.viewerCount - 1);
    this.lastViewerAt = this.deps.ports.now();
  }

  noteActivity(): void {
    this.lastActivityAt = this.deps.ports.now();
  }

  // -------------------------------------------------------------- profiles

  setUserDataDir(dir: string | null, name: string | null): void {
    this.userDataDirOverride = dir;
    this.profileName = name;
  }

  /**
   * Best-effort storage-state snapshot (Phase 3): cookies via CDP
   * `Storage.getCookies`; per-origin localStorage is deferred.
   */
  async captureStorageState(): Promise<unknown> {
    const version = (await this.deps.ports.fetchJson(
      `http://127.0.0.1:${this.slot.cdpPort}/json/version`,
      2_000,
    )) as { webSocketDebuggerUrl?: string } | null;
    if (!version?.webSocketDebuggerUrl) throw new Error("browser CDP endpoint unreachable");
    const transport = await this.deps.ports.openWebSocket(version.webSocketDebuggerUrl);
    const client = new CdpClient(transport);
    try {
      const cookies = (await client.send("Storage.getCookies")) as { cookies?: unknown[] };
      return { cookies: cookies.cookies ?? [], origins: [] };
    } finally {
      client.close();
    }
  }

  // -------------------------------------------------------------------- rpc

  /** Stateless facade call over the backing stdio child (Part 10.4). */
  async rpc(kind: McpKind, message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    this.noteActivity();
    const id = message.id ?? null;
    if (this.machine.state === "error") {
      return id === undefined || id === null
        ? null
        : errorResponse(id, -32000, "session in error state — DELETE then POST to reset");
    }
    if (!canAcceptToolCalls(this.machine)) {
      if (message.id === undefined) return null;
      if (this.machine.mode === "operator") {
        // Mode gate: clean errorResult so agents just retry later.
        return message.method === "tools/call"
          ? takeoverResult(message.id)
          : errorResponse(message.id, -32000, TAKEOVER_ERROR);
      }
      return errorResponse(message.id, -32000, `session not ready (state=${this.machine.state})`);
    }
    if (message.method === undefined) {
      return id === null ? null : errorResponse(id, -32600, "invalid request: missing method");
    }
    let child = this.children[kind];
    if (!child || child.closed) {
      try {
        child = await this.restartChild(kind);
      } catch (err) {
        return id === null
          ? null
          : errorResponse(id, -32000, `${kind} child unavailable: ${String(err)}`);
      }
    }
    if (message.id === undefined) {
      // Notification: forward, no response.
      child.notify(message.method, message.params);
      return null;
    }
    // `initialize` is synthesized from the cached handshake (Part 10.4).
    if (message.method === "initialize") {
      return { jsonrpc: "2.0", id: message.id, result: child.initializeResult };
    }
    try {
      const result = await child.call(message.method, message.params, this.deps.config.requestTimeoutMs);
      return { jsonrpc: "2.0", id: message.id, result };
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -32000;
      return errorResponse(message.id, code, String(err instanceof Error ? err.message : err));
    }
  }

  // ------------------------------------------------------------- screencast

  private ensureScreencast(): ScreencastEngine {
    if (!this.screencast) {
      this.screencast = new ScreencastEngine({
        cdpHttpBase: `http://127.0.0.1:${this.slot.cdpPort}`,
        openTransport: (url) => this.deps.ports.openWebSocket(url),
        fetchJson: (url, timeoutMs) => this.deps.ports.fetchJson(url, timeoutMs),
        maxFps: this.deps.config.screencastFps,
        log: this.deps.log,
      });
    }
    return this.screencast;
  }

  addCastViewer(conn: ViewerConn): void {
    this.noteActivity();
    this.ensureScreencast().addViewer(conn);
  }

  removeCastViewer(conn: ViewerConn): void {
    this.screencast?.removeViewer(conn);
  }

  // ------------------------------------------------------------------- info

  async toInfo(): Promise<SessionInfo> {
    const pid = this.chromiumPid;
    return {
      project: this.project,
      state: this.machine.state,
      mode: this.machine.mode,
      display: this.slot.display,
      cdpPort: this.slot.cdpPort,
      vncPort: this.slot.vncPort,
      wsPort: this.slot.wsPort,
      currentUrl: this.screencast?.currentUrl ?? null,
      title: null,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      viewers: this.viewerCount,
      bootCount: this.bootCount,
      crashCount: this.crashCount,
      ramBytes: pid ? await this.deps.ports.processRssBytes(pid) : null,
      artifactCount: this.deps.artifactCount(this.project),
      profile: this.profileName,
    };
  }

  toInfoWithTimeline(): Promise<SessionInfo> {
    return this.toInfo().then((info) => ({ ...info, timeline: [...this.timeline] }));
  }
}

export function errorResponse(id: number | string | null, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function takeoverResult(id: number | string | null): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: TAKEOVER_ERROR }], isError: true },
  };
}

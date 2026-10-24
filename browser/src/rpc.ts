import type { SpawnedProcess, SpawnSpec, ProcessSpawner } from "./spawner.js";

/** Newline-delimited JSON-RPC framing over an MCP child's stdio. */
export interface StdioChannel {
  writeLine(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: () => void): void;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function channelFromProcess(proc: SpawnedProcess): StdioChannel {
  const lineHandlers: Array<(line: string) => void> = [];
  const closeHandlers: Array<() => void> = [];
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) for (const handler of lineHandlers) handler(line);
      idx = buffer.indexOf("\n");
    }
  });
  proc.onExit(() => {
    for (const handler of closeHandlers) handler();
  });
  return {
    writeLine: (line) => {
      proc.stdin.write(`${line}\n`);
    },
    onLine: (cb) => {
      lineHandlers.push(cb);
    },
    onClose: (cb) => {
      closeHandlers.push(cb);
    },
  };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * JSON-RPC client over newline-delimited stdio: request/response matching by
 * id (out-of-order responses are fine), timeout, and pending-call rejection on
 * child death.
 */
export class StdioJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private isClosed = false;
  private readonly closeHandlers: Array<() => void> = [];

  constructor(
    private readonly channel: StdioChannel,
    private readonly opts: { requestTimeoutMs?: number; name?: string } = {},
  ) {
    channel.onLine((line) => this.handleLine(line));
    channel.onClose(() => this.handleClose());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    const id = msg.id;
    if (id === undefined || id === null) return; // notification or server push — not correlated
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.error) pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else pending.resolve(msg.result);
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.failAll(`${this.opts.name ?? "child"} closed`);
    for (const handler of this.closeHandlers) handler();
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.isClosed) {
      return Promise.reject(new RpcError(-32001, `${this.opts.name ?? "child"} closed`));
    }
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32001, `request timeout after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.channel.writeLine(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.isClosed) return;
    const message: JsonRpcMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    try {
      this.channel.writeLine(JSON.stringify(message));
    } catch {
      /* child gone — notifications are fire-and-forget */
    }
  }

  /** Reject every in-flight request (crash policy: error in-flight calls). */
  failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new RpcError(-32001, reason));
    }
  }

  onClose(cb: () => void): void {
    this.closeHandlers.push(cb);
    if (this.isClosed) cb();
  }

  /** Process teardown is the supervisor's job; this just settles in-flight calls. */
  close(): void {
    this.handleClose();
  }
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpChildOptions {
  name: string;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * One MCP stdio child (`@playwright/mcp` / `chrome-devtools-mcp`) with the real
 * `initialize` handshake performed once at spawn time; its result is cached and
 * synthesized for later client `initialize` calls (Part 10.4).
 */
export class McpChild {
  private exited = false;

  private constructor(
    readonly name: string,
    private readonly proc: SpawnedProcess,
    private readonly client: StdioJsonRpcClient,
    readonly initializeResult: unknown,
  ) {
    proc.onExit(() => {
      this.exited = true;
    });
  }

  static async start(
    spawner: ProcessSpawner,
    spec: SpawnSpec,
    opts: McpChildOptions,
  ): Promise<McpChild> {
    const proc = spawner.spawn(spec);
    const client = new StdioJsonRpcClient(channelFromProcess(proc), {
      name: opts.name,
      requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
    });
    const initializeResult = await client.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "browser-orchestrator", version: "0.1.0" },
      },
      opts.handshakeTimeoutMs ?? 8_000,
    );
    client.notify("notifications/initialized");
    return new McpChild(opts.name, proc, client, initializeResult);
  }

  get closed(): boolean {
    return this.exited || this.client.closed;
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    return this.client.request(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.client.notify(method, params);
  }

  failAll(reason: string): void {
    this.client.failAll(reason);
  }

  onExit(cb: () => void): void {
    this.proc.onExit(() => cb());
  }

  /** SIGTERM, SIGKILL after grace (shutdown order — Part 10.2). */
  async shutdown(graceMs: number): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve) => this.proc.onExit(() => resolve()));
    this.proc.kill("SIGTERM");
    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
    if (!this.exited) this.proc.kill("SIGKILL");
  }
}

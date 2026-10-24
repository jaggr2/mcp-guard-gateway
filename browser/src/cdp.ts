/**
 * Raw CDP client over any WebSocket-ish transport. Used by the screencast
 * engine and the profile storage-state snapshot; kept transport-injectable so
 * tests never need a real browser.
 */
export interface RawTransport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class CdpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, EventHandler[]>();
  private closed = false;

  constructor(private readonly transport: RawTransport) {
    transport.onMessage((data) => this.handleMessage(data));
    transport.onClose(() => {
      this.closed = true;
      for (const call of this.pending.values()) call.reject(new CdpError(-1, "cdp transport closed"));
      this.pending.clear();
    });
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id === "number" && this.pending.has(id)) {
      const call = this.pending.get(id)!;
      this.pending.delete(id);
      const error = msg["error"] as { code?: number; message?: string; data?: unknown } | undefined;
      if (error) call.reject(new CdpError(error.code ?? -1, error.message ?? "cdp error", error.data));
      else call.resolve(msg["result"]);
      return;
    }
    const method = msg["method"];
    if (typeof method === "string") {
      const sessionId = typeof msg["sessionId"] === "string" ? (msg["sessionId"] as string) : undefined;
      const params = (msg["params"] as Record<string, unknown>) ?? {};
      for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new CdpError(-1, "cdp transport closed"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload["sessionId"] = sessionId;
    this.transport.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  on(method: string, handler: EventHandler): () => void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => {
      this.handlers.set(method, (this.handlers.get(method) ?? []).filter((h) => h !== handler));
    };
  }

  close(): void {
    if (!this.closed) this.transport.close();
    this.closed = true;
  }
}

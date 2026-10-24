import type { RawTransport } from "./cdp.js";
import { CdpClient } from "./cdp.js";
import type { Logger } from "./logger.js";

export interface ViewerConn {
  sendJson(obj: unknown): void;
  sendBinary(data: Buffer, cb?: () => void): void;
  close(): void;
  onClose(cb: () => void): void;
}

interface Frame {
  data: string;
  url: string;
  ts: number;
}

interface ViewerSlot {
  conn: ViewerConn;
  pending: Frame | null;
  sending: boolean;
}

interface ScreencastDeps {
  /** CDP HTTP base, e.g. http://127.0.0.1:9221 */
  cdpHttpBase: string;
  openTransport: (url: string) => Promise<RawTransport>;
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown | null>;
  maxFps?: number;
  log: Logger;
}

/**
 * Screencast engine (Part 10.5, Phase 2): orchestrator-owned CDP session runs
 * `Page.startScreencast` (webp q60 ≤1280x720), frames fan out to `/p/:project/cast`
 * WS viewers with latest-frame-only buffering behind a token bucket; the
 * screencast stops when the last viewer disconnects and re-arms on target
 * changes.
 */
export class ScreencastEngine {
  private viewers = new Set<ViewerSlot>();
  private client: CdpClient | null = null;
  /** targetId → flattened CDP sessionId */
  private sessions = new Map<string, string>();
  private stopped = true;
  private framesTotal = 0;
  private lastEmit = 0;
  private lastUrl: string | null = null;

  constructor(private readonly deps: ScreencastDeps) {}

  get frameCount(): number {
    return this.framesTotal;
  }

  get currentUrl(): string | null {
    return this.lastUrl;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  addViewer(conn: ViewerConn): void {
    const slot: ViewerSlot = { conn, pending: null, sending: false };
    this.viewers.add(slot);
    conn.onClose(() => this.removeViewer(conn));
    if (this.stopped) {
      void this.start().catch((err) => {
        this.deps.log.warn("screencast start failed", { err: String(err) });
      });
    }
  }

  removeViewer(conn: ViewerConn): void {
    for (const slot of this.viewers) {
      if (slot.conn === conn) this.viewers.delete(slot);
    }
    // Presence = WS open/close: stop the CDP screencast with the last viewer.
    if (this.viewers.size === 0) {
      void this.stop();
    }
  }

  removeAllViewers(): void {
    for (const slot of [...this.viewers]) {
      try {
        slot.conn.close();
      } catch {
        /* ignore */
      }
      this.viewers.delete(slot);
    }
  }

  private async start(): Promise<void> {
    this.stopped = false;
    const version = (await this.deps.fetchJson(`${this.deps.cdpHttpBase}/json/version`, 2_000)) as
      | { webSocketDebuggerUrl?: string }
      | null;
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("cdp endpoint unreachable");
    const transport = await this.deps.openTransport(wsUrl);
    const client = new CdpClient(transport);
    this.client = client;

    client.on("Target.targetCreated", (params) => {
      const info = params["targetInfo"] as { type?: string; targetId?: string } | undefined;
      if (info?.type === "page" && info.targetId) void this.attach(client, info.targetId);
    });
    client.on("Target.targetDestroyed", (params) => {
      this.sessions.delete(String(params["targetId"] ?? ""));
    });
    client.on("Page.frameNavigated", (params, _sessionId) => {
      const frame = params["frame"] as { parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && frame.url) this.lastUrl = frame.url;
    });
    client.on("Page.screencastFrame", (params, sessionId) => {
      this.onFrame(params, sessionId);
    });

    await client.send("Target.setDiscoverTargets", { discover: true });
    const targets = (await client.send("Target.getTargets")) as {
      targetInfos?: Array<{ type: string; targetId: string; url?: string }>;
    };
    for (const info of targets.targetInfos ?? []) {
      if (info.type === "page") {
        if (info.url) this.lastUrl = info.url;
        await this.attach(client, info.targetId);
      }
    }
    this.deps.log.info("screencast started", { viewers: this.viewers.size });
  }

  private async attach(client: CdpClient, targetId: string): Promise<void> {
    try {
      const res = (await client.send("Target.attachToTarget", { targetId, flatten: true })) as {
        sessionId: string;
      };
      this.sessions.set(targetId, res.sessionId);
      await client.send("Page.enable", {}, res.sessionId);
      await client.send(
        "Page.startScreencast",
        { format: "webp", quality: 60, maxWidth: 1280, maxHeight: 720 },
        res.sessionId,
      );
    } catch (err) {
      this.deps.log.warn("screencast attach failed", { targetId, err: String(err) });
    }
  }

  private onFrame(params: Record<string, unknown>, sessionId?: string): void {
    const data = params["data"];
    if (typeof data !== "string") return;
    if (sessionId && this.client) {
      // Ack the frame with its screencast session id (a number, per CDP spec).
      void this.client
        .send("Page.screencastFrameAck", { sessionId: params["sessionId"] }, sessionId)
        .catch(() => undefined);
    }
    // Token bucket: cap emission at maxFps; excess frames are dropped, never queued.
    const now = Date.now();
    const minInterval = 1_000 / (this.deps.maxFps ?? 5);
    if (now - this.lastEmit < minInterval) return;
    this.lastEmit = now;
    this.framesTotal++;
    const frame: Frame = { data, url: this.lastUrl ?? "", ts: now };
    for (const slot of this.viewers) {
      slot.pending = frame; // latest-frame-only
      this.flush(slot);
    }
  }

  private flush(slot: ViewerSlot): void {
    if (slot.sending) return;
    const frame = slot.pending;
    if (!frame) return;
    slot.pending = null;
    slot.sending = true;
    try {
      slot.conn.sendJson({ type: "frame", url: frame.url, ts: frame.ts });
      slot.conn.sendBinary(Buffer.from(frame.data, "base64"), () => {
        slot.sending = false;
        this.flush(slot);
      });
    } catch {
      slot.sending = false;
      this.removeViewer(slot.conn);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const client = this.client;
    this.client = null;
    if (!client) return;
    for (const sessionId of this.sessions.values()) {
      await client.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
    }
    this.sessions.clear();
    client.close();
    this.deps.log.info("screencast stopped", { frames: this.framesTotal });
  }
}

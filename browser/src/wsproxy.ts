import { connect as netConnect } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Logger } from "./logger.js";
import type { SessionHandle, SessionRegistry } from "./registry.js";
import type { ViewerConn } from "./screencast.js";
import { isProjectId } from "./slug.js";

/**
 * Raw byte pipe to one x11vnc RFB port (a net.Socket in production; faked in
 * tests so the routing rules are unit-testable without Xvfb).
 */
export interface RfbConnection {
  write(data: Buffer): void;
  destroy(): void;
  onData(cb: (chunk: Buffer) => void): void;
  /** Fires once on close *or* error. */
  onClose(cb: () => void): void;
}

export type RfbConnector = (port: number) => Promise<RfbConnection>;

/** Production connector: plain TCP to 127.0.0.1:<rfbport>. */
export const openRfb: RfbConnector = (port) =>
  new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: "127.0.0.1" });
    socket.once("error", reject);
    socket.once("connect", () => {
      let closed = false;
      resolve({
        write: (data) => {
          socket.write(data);
        },
        destroy: () => {
          socket.destroy();
        },
        onData: (cb) => {
          socket.on("data", cb);
        },
        onClose: (cb) => {
          socket.on("close", () => {
            closed = true;
            cb();
          });
          socket.on("error", () => {
            if (!closed) {
              closed = true;
              cb();
            }
          });
        },
      });
    });
  });

export interface UpgradeDeps {
  registry: SessionRegistry;
  log: Logger;
  /** Dial one x11vnc RFB port (defaults to {@link openRfb}). */
  connectRfb?: RfbConnector;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Viewer WebSocket endpoints (Part 10.4) — no token auth, Authelia forwardAuth
 * is in front at the reverse proxy:
 *   WS /p/:project/vnc  → RFB relay to the session's x11vnc
 *   WS /p/:project/cast → screencast frames (latest-frame-only fan-out)
 *
 * Watching is passive: connecting to `/vnc` never changes the session mode.
 * The upstream port is picked **at connect time** from the session mode:
 *   agent    → the view-only x11vnc (590N, `-viewonly`) — input never reaches
 *              Chromium;
 *   operator → the interactive x11vnc (609N) — takeover input flows through.
 * Entering `operator` is explicit (`POST /api/sessions/:slug/mode`); clients
 * that want to drive reconnect after the mode flip to pick up the interactive
 * route.
 */
export function createUpgradeHandler(deps: UpgradeDeps) {
  const wss = new WebSocketServer({
    noServer: true,
    // Mirror websockify: pick `binary` when offered (raw bytes in binary frames).
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  const connectRfb = deps.connectRfb ?? openRfb;

  const viewerConn = (ws: WebSocket): ViewerConn => ({
    sendJson: (obj) => {
      ws.send(JSON.stringify(obj));
    },
    sendBinary: (data, cb) => {
      ws.send(data, { binary: true }, () => cb?.());
    },
    close: () => {
      ws.close();
    },
    onClose: (cb) => {
      ws.on("close", () => cb());
    },
  });

  async function attachVnc(ws: WebSocket, session: SessionHandle): Promise<void> {
    const interactive = session.mode === "operator";
    const upstream = await connectRfb(interactive ? session.vncInputPort : session.vncPort);
    if (interactive) session.takeoverViewerOpened();
    else session.watcherOpened();
    let closed = false;
    const closeBoth = (): void => {
      if (closed) return;
      closed = true;
      if (interactive) session.takeoverViewerClosed();
      else session.watcherClosed();
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    upstream.onData((chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    });
    upstream.onClose(closeBoth);
    ws.on("message", (data) => upstream.write(toBuffer(data)));
    ws.on("close", closeBoth);
    ws.on("error", closeBoth);
  }

  function attachCast(ws: WebSocket, session: SessionHandle): void {
    const conn = viewerConn(ws);
    session.addCastViewer(conn);
    ws.on("close", () => session.removeCastViewer(conn));
    ws.on("error", () => session.removeCastViewer(conn));
  }

  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/p\/([^/]+)\/(vnc|cast)$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const project = decodeURIComponent(match[1]);
    const kind = match[2];
    if (!isProjectId(project)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void (async () => {
        try {
          const session = await deps.registry.ensure(project);
          if (kind === "vnc") await attachVnc(ws, session);
          else attachCast(ws, session);
        } catch (err) {
          deps.log.warn("viewer ws rejected", { project, kind, err: String(err) });
          try {
            ws.close(1011, "session unavailable");
          } catch {
            /* ignore */
          }
        }
      })();
    });
  };
}

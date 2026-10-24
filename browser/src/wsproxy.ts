import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "./logger.js";
import type { SessionHandle, SessionRegistry } from "./registry.js";
import type { ViewerConn } from "./screencast.js";
import { isProjectId } from "./slug.js";

export interface UpgradeDeps {
  registry: SessionRegistry;
  log: Logger;
}

/**
 * Viewer WebSocket endpoints (Part 10.4) — no token auth, Authelia forwardAuth
 * is in front at the reverse proxy:
 *   WS /p/:project/vnc  → raw WS proxy to websockify (608N) — interactive takeover
 *   WS /p/:project/cast → screencast frames (latest-frame-only fan-out)
 */
export function createUpgradeHandler(deps: UpgradeDeps) {
  const wss = new WebSocketServer({ noServer: true });

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
    const upstream = new WebSocket(`ws://127.0.0.1:${session.wsPort}`);
    session.viewerOpened();
    // Opening the noVNC WS flips the session to operator mode (takeover).
    session.takeover("vnc viewer connected");
    const closeBoth = (): void => {
      session.viewerClosed();
      try {
        upstream.close();
      } catch {
        /* ignore */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    upstream.on("message", (data) => ws.send(data));
    ws.on("message", (data) => upstream.send(data));
    upstream.on("close", closeBoth);
    upstream.on("error", closeBoth);
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

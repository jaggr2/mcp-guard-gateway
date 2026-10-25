import type { SessionMode, SessionState } from "./machine.js";
import type { JsonRpcMessage } from "./rpc.js";
import type { ViewerConn } from "./screencast.js";

export type McpKind = "playwright" | "devtools";

export interface TimelineEvent {
  ts: number;
  type: string;
  detail?: string;
}

export interface SessionInfo {
  project: string;
  state: SessionState;
  mode: SessionMode;
  display: string;
  cdpPort: number;
  vncPort: number;
  wsPort: number;
  currentUrl: string | null;
  title: string | null;
  startedAt: number | null;
  lastActivityAt: number;
  /** Passive noVNC watchers (view-only route — never flips the mode). */
  viewers: number;
  /** Interactive noVNC connections (takeover route — operator input). */
  takeoverViewers: number;
  bootCount: number;
  crashCount: number;
  ramBytes: number | null;
  artifactCount: number;
  profile: string | null;
  timeline?: TimelineEvent[];
}

export interface MetricsSnapshot {
  poolTotal: number;
  poolUsed: number;
  sessionsByState: Record<SessionState, number>;
  bootsTotal: number;
  crashesTotal: number;
  screencastFramesTotal: number;
  freeRamBytes: number;
}

/** One live session as seen by the HTTP layer and the WS upgrade handler. */
export interface SessionHandle {
  readonly project: string;
  readonly state: SessionState;
  readonly mode: SessionMode;
  /** View-only x11vnc RFB port (input gated off). */
  readonly vncPort: number;
  /** websockify WS port (→ view-only x11vnc). */
  readonly wsPort: number;
  /** Interactive x11vnc RFB port (takeover input). */
  readonly vncInputPort: number;
  /** Stateless JSON-RPC facade call; null response = notification (202). */
  rpc(kind: McpKind, message: JsonRpcMessage): Promise<JsonRpcMessage | null>;
  /** A passive noVNC watcher (view-only route). Never flips the mode. */
  watcherOpened(): void;
  watcherClosed(): void;
  /** An interactive noVNC connection (takeover route). Holds the auto-release timer. */
  takeoverViewerOpened(): void;
  takeoverViewerClosed(): void;
  takeover(reason: string): void;
  release(reason: string): void;
  addCastViewer(conn: ViewerConn): void;
  removeCastViewer(conn: ViewerConn): void;
  toInfo(): Promise<SessionInfo>;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 503,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface SessionRegistry {
  /** Boot the session if needed and wait for readiness (first-call boot). */
  ensure(project: string): Promise<SessionHandle>;
  get(project: string): SessionHandle | undefined;
  list(): Promise<SessionInfo[]>;
  info(project: string): Promise<SessionInfo | null>;
  teardown(project: string): Promise<void>;
  setMode(project: string, mode: SessionMode): Promise<SessionInfo>;
  profileAction(project: string, action: "attach" | "commit" | "detach", name: string): Promise<SessionInfo>;
  metrics(): Promise<MetricsSnapshot>;
  shutdown(): Promise<void>;
}

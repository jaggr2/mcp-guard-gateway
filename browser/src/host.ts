import { readFile } from "node:fs/promises";
import { freemem } from "node:os";
import { connect } from "node:net";
import { WebSocket } from "ws";
import type { RawTransport } from "./cdp.js";

/**
 * Host/environment interaction used by the session supervisor — injected next to
 * {@link ProcessSpawner} so boot readiness, RAM checks and CDP access are all
 * mockable in unit tests (this dev machine has no Xvfb/Chromium).
 */
export interface SupervisorPorts {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** GET url and parse JSON; null when unreachable / non-2xx / invalid. */
  fetchJson(url: string, timeoutMs: number): Promise<unknown | null>;
  /** Open a raw CDP WebSocket transport. */
  openWebSocket(url: string): Promise<RawTransport>;
  isPortListening(port: number, host: string, timeoutMs: number): Promise<boolean>;
  freeRamBytes(): Promise<number>;
  /** Resident set size of a pid, or null when unknowable (e.g. non-Linux). */
  processRssBytes(pid: number): Promise<number | null>;
}

export class RealSupervisorPorts implements SupervisorPorts {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as unknown;
    } catch {
      return null;
    }
  }

  async openWebSocket(url: string): Promise<RawTransport> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    return {
      send: (data) => {
        ws.send(data);
      },
      onMessage: (cb) => {
        ws.on("message", (data) => cb(data.toString()));
      },
      onClose: (cb) => {
        ws.on("close", () => cb());
      },
      close: () => {
        ws.close();
      },
    };
  }

  isPortListening(port: number, host: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ port, host });
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(value);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
    });
  }

  freeRamBytes(): Promise<number> {
    return Promise.resolve(freemem());
  }

  async processRssBytes(pid: number): Promise<number | null> {
    try {
      const text = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /VmRSS:\s+(\d+)\s+kB/.exec(text);
      return match ? Number(match[1]) * 1024 : null;
    } catch {
      return null;
    }
  }
}

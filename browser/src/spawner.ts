import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * Everything the supervisor spawns goes through this interface (execFile-style,
 * no shell) so the session supervisor is fully unit-testable on machines that
 * have no Xvfb/Chromium/x11vnc at all (Part 10.1 / 10.2).
 */
export interface WritableLike {
  write(data: string): boolean;
  end(): void;
}

export interface ReadableLike {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly stdin: WritableLike;
  readonly stdout: ReadableLike;
  readonly stderr: ReadableLike;
  /** Fires exactly once, on exit or on spawn failure. */
  onExit(cb: (info: ExitInfo) => void): void;
  kill(signal?: string): boolean;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface ProcessSpawner {
  spawn(spec: SpawnSpec): SpawnedProcess;
}

class NodeProcess implements SpawnedProcess {
  private readonly exitHandlers: Array<(info: ExitInfo) => void> = [];
  private done = false;

  constructor(private readonly child: ChildProcess) {
    child.on("exit", (code, signal) => this.finish({ code, signal }));
    child.on("error", () => this.finish({ code: null, signal: null }));
  }

  private finish(info: ExitInfo): void {
    if (this.done) return;
    this.done = true;
    for (const handler of this.exitHandlers) handler(info);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdin(): WritableLike {
    return this.child.stdin as unknown as WritableLike;
  }

  get stdout(): ReadableLike {
    return this.child.stdout as unknown as ReadableLike;
  }

  get stderr(): ReadableLike {
    return this.child.stderr as unknown as ReadableLike;
  }

  onExit(cb: (info: ExitInfo) => void): void {
    this.exitHandlers.push(cb);
    if (this.done) cb({ code: null, signal: null });
  }

  kill(signal?: string): boolean {
    return this.child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
  }
}

/** Real spawner: child_process.spawn with shell disabled. */
export class RealProcessSpawner implements ProcessSpawner {
  spawn(spec: SpawnSpec): SpawnedProcess {
    const child = nodeSpawn(spec.file, spec.args, {
      env: { ...process.env, ...spec.env },
      cwd: spec.cwd,
      shell: false,
      stdio: "pipe",
      windowsHide: true,
    });
    return new NodeProcess(child);
  }
}

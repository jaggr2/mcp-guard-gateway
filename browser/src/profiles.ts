import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SLUG_RE } from "./slug.js";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

interface LockInfo {
  project: string;
  ts: number;
}

/**
 * Browser profiles (Part 10.7, Phase 3): `<PROFILES_DIR>/<name>/` user-data-dirs
 * plus `storage-state-<name>.json` snapshots. Profiles are credentials:
 * `0600`, and a lock file enforces one-session-at-a-time use (flock semantics
 * approximated with an O_EXCL lock file so it works on any filesystem).
 */
export class ProfileStore {
  private readonly holders = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  static validName(name: string): boolean {
    return SLUG_RE.test(name);
  }

  profileDir(name: string): string {
    return path.join(this.root, name);
  }

  storageStatePath(name: string): string {
    return path.join(this.root, `storage-state-${name}.json`);
  }

  lockPath(name: string): string {
    return path.join(this.root, `${name}.lock`);
  }

  async list(): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root).catch(() => [] as string[]);
    const names = new Set<string>();
    for (const entry of entries) {
      if (entry.endsWith(".lock")) continue;
      if (entry.startsWith("storage-state-") && entry.endsWith(".json")) {
        names.add(entry.slice("storage-state-".length, -".json".length));
      } else {
        names.add(entry);
      }
    }
    return [...names].sort();
  }

  holder(name: string): string | null {
    return this.holders.get(name) ?? null;
  }

  async attach(name: string, project: string): Promise<string> {
    if (!ProfileStore.validName(name)) throw new ProfileError(`invalid profile name: ${name}`);
    await mkdir(this.root, { recursive: true });
    const dir = this.profileDir(name);
    await mkdir(dir, { recursive: true });
    await this.lock(dir, name, project);
    await chmod(dir, 0o700).catch(() => undefined);
    return dir;
  }

  /** Snapshot storage-state JSON (0600) and hand the profile back to the pool. */
  async commit(name: string, storageState: unknown): Promise<string> {
    if (!this.holders.has(name)) throw new ProfileError(`profile not attached: ${name}`);
    const file = this.storageStatePath(name);
    await writeFile(file, JSON.stringify(storageState, null, 2), { mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
    return file;
  }

  async detach(name: string): Promise<void> {
    await this.unlock(name);
  }

  private async lock(dir: string, name: string, project: string): Promise<void> {
    if (this.holders.has(name)) {
      throw new ProfileError(`profile ${name} already in use by ${this.holders.get(name)}`);
    }
    const lock = this.lockPath(name);
    const info: LockInfo = { project, ts: this.now() };
    try {
      await writeFile(lock, JSON.stringify(info), { flag: "wx", mode: 0o600 });
    } catch (err) {
      // Stale lock from a previous orchestrator life? Refuse and surface it —
      // profiles are credentials, never steal a lock silently.
      let holder = "unknown";
      try {
        holder = (JSON.parse(await readFile(lock, "utf8")) as LockInfo).project;
      } catch {
        /* unreadable lock */
      }
      throw new ProfileError(`profile ${name} is locked by ${holder}`);
    }
    this.holders.set(name, project);
    void dir;
  }

  private async unlock(name: string): Promise<void> {
    this.holders.delete(name);
    await rm(this.lockPath(name), { force: true }).catch(() => undefined);
  }

  async storageState(name: string): Promise<unknown | null> {
    try {
      await stat(this.storageStatePath(name));
      return JSON.parse(await readFile(this.storageStatePath(name), "utf8")) as unknown;
    } catch {
      return null;
    }
  }
}

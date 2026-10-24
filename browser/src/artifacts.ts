import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface Artifact {
  /** Path-safe content id (sha256 prefix) used by GET /artifacts/:id. */
  id: string;
  project: string;
  callId: string;
  name: string;
  /** Absolute path in the store. */
  path: string;
  size: number;
  createdAt: number;
  lastAccessAt: number;
}

const ID_RE = /^[a-f0-9]{16}$/;

export function isArtifactId(value: string): boolean {
  return ID_RE.test(value);
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

/**
 * Artifact store (Part 10.6): playwright `--output-dir` staging is captured
 * after each `tools/call` into `<root>/<project>/<call-id>/` and referenced by a
 * content id. Daily GC: 14 days AND 5 GB total (LRU eviction first).
 */
export class ArtifactStore {
  private readonly index = new Map<string, Artifact>();

  constructor(
    private readonly root: string,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  stagingDir(project: string): string {
    return path.join(this.root, "_staging", project);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, "_staging"), { recursive: true });
    // Rebuild the content-id index from the on-disk layout.
    let projects: string[] = [];
    try {
      projects = await readdir(this.root);
    } catch {
      return;
    }
    for (const project of projects) {
      if (project === "_staging") continue;
      let callDirs: string[] = [];
      try {
        callDirs = await readdir(path.join(this.root, project));
      } catch {
        continue;
      }
      for (const callId of callDirs) {
        const dir = path.join(this.root, project, callId);
        let files: string[] = [];
        try {
          files = await readdir(dir);
        } catch {
          continue;
        }
        for (const file of files) {
          const full = path.join(dir, file);
          const match = /^([a-f0-9]{16})-/.exec(file);
          if (!match) continue;
          try {
            const st = await stat(full);
            this.index.set(match[1], {
              id: match[1],
              project,
              callId,
              name: file.slice(17),
              path: full,
              size: st.size,
              createdAt: st.mtimeMs,
              lastAccessAt: st.mtimeMs,
            });
          } catch {
            /* skip unreadable entries */
          }
        }
      }
    }
  }

  /**
   * Capture files written to the session's staging dir since `since` into
   * `<root>/<project>/<call-id>/` and return the registered artifacts.
   */
  async capture(project: string, callId: string, since: number): Promise<Artifact[]> {
    const staging = this.stagingDir(project);
    let entries: string[] = [];
    try {
      entries = await readdir(staging);
    } catch {
      return [];
    }
    const captured: Artifact[] = [];
    const outDir = path.join(this.root, project, callId);
    for (const entry of entries) {
      const full = path.join(staging, entry);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs < since - 2_000) continue;
      const bytes = await readFile(full);
      const id = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const existing = this.index.get(id);
      if (existing) {
        // Content already captured under another call — reuse its id.
        await rm(full, { force: true }).catch(() => undefined);
        captured.push(existing);
        continue;
      }
      await mkdir(outDir, { recursive: true });
      const name = safeName(entry);
      const dest = path.join(outDir, `${id}-${name}`);
      await rename(full, dest).catch(async () => {
        await writeFile(dest, bytes);
        await rm(full, { force: true }).catch(() => undefined);
      });
      const artifact: Artifact = {
        id,
        project,
        callId,
        name,
        path: dest,
        size: bytes.length,
        createdAt: this.now(),
        lastAccessAt: this.now(),
      };
      this.index.set(id, artifact);
      captured.push(artifact);
    }
    return captured;
  }

  get(id: string): Artifact | undefined {
    const artifact = this.index.get(id);
    if (artifact) artifact.lastAccessAt = this.now();
    return artifact;
  }

  list(project: string): Artifact[] {
    return [...this.index.values()]
      .filter((a) => a.project === project)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  count(project: string): number {
    return this.list(project).length;
  }

  totalBytes(): number {
    let total = 0;
    for (const a of this.index.values()) total += a.size;
    return total;
  }

  /** Daily GC: drop anything older than maxAgeMs, then LRU-evict over maxBytes. */
  async gc(maxAgeMs: number, maxTotalBytes: number): Promise<{ removed: number; freedBytes: number }> {
    let removed = 0;
    let freedBytes = 0;
    const now = this.now();
    const byAge: Artifact[] = [];
    for (const a of [...this.index.values()]) {
      if (now - a.createdAt > maxAgeMs) byAge.push(a);
    }
    for (const a of byAge) {
      await this.remove(a);
      removed++;
      freedBytes += a.size;
    }
    // LRU eviction first (least recently accessed artifacts go first).
    while (this.totalBytes() > maxTotalBytes) {
      const all = [...this.index.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt);
      const victim = all[0];
      if (!victim) break;
      await this.remove(victim);
      removed++;
      freedBytes += victim.size;
    }
    return { removed, freedBytes };
  }

  private async remove(a: Artifact): Promise<void> {
    this.index.delete(a.id);
    await rm(a.path, { force: true }).catch(() => undefined);
    // Drop the call-id dir when empty (non-empty dirs are left alone).
    await rmdir(path.dirname(a.path)).catch(() => undefined);
  }

  /** Best-effort: refuse capture when the store is over budget (calls still work). */
  async underBudget(maxTotalBytes: number): Promise<boolean> {
    return this.totalBytes() <= maxTotalBytes;
  }
}

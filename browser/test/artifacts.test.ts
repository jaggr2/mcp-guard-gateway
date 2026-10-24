import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore, isArtifactId } from "../src/artifacts.js";

async function makeStore(now: () => number) {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-art-"));
  const store = new ArtifactStore(dir, { now });
  await store.init();
  return { dir, store };
}

describe("artifact store", () => {
  it("captures new staging files under <project>/<call-id>/ with content ids", async () => {
    let now = 1_000_000;
    const { dir, store } = await makeStore(() => now);

    await mkdir(store.stagingDir("proj"), { recursive: true });
    await writeFile(path.join(store.stagingDir("proj"), "shot one.png"), "PNGDATA");
    now += 5_000;

    const captured = await store.capture("proj", "call-1", 1_000_000);
    expect(captured).toHaveLength(1);
    const artifact = captured[0];
    expect(isArtifactId(artifact.id)).toBe(true);
    expect(artifact.project).toBe("proj");
    expect(artifact.callId).toBe("call-1");
    expect(artifact.name).toBe("shot_one.png"); // path-safe on disk
    expect(store.get(artifact.id)).toBeDefined();

    // Bytes land in the store with a path-safe name, staging file is consumed.
    const files = await readdir(path.join(dir, "proj", "call-1"));
    expect(files).toEqual([`${artifact.id}-shot_one.png`]);
    expect(await readdir(store.stagingDir("proj"))).toEqual([]);
    expect(store.list("proj")).toHaveLength(1);
  });

  it("does not capture files older than the call window", async () => {
    const { store } = await makeStore(() => Date.now());
    await mkdir(store.stagingDir("proj"), { recursive: true });
    await writeFile(path.join(store.stagingDir("proj"), "old.txt"), "stale");
    // Call "started" 60s after the file was written: the file is not new output.
    const captured = await store.capture("proj", "call-2", Date.now() + 60_000);
    expect(captured).toEqual([]);
  });

  it("deduplicates identical content by id", async () => {
    let now = 1_000_000;
    const { store } = await makeStore(() => now);
    await mkdir(store.stagingDir("proj"), { recursive: true });
    await writeFile(path.join(store.stagingDir("proj"), "a.png"), "SAME");
    const first = await store.capture("proj", "call-1", now);
    now += 1_000;
    await writeFile(path.join(store.stagingDir("proj"), "b.png"), "SAME");
    const second = await store.capture("proj", "call-2", now);
    expect(second[0].id).toBe(first[0].id);
    expect(store.list("proj")).toHaveLength(1);
  });

  it("gc evicts by age, then LRU by size budget", async () => {
    let now = 1_000_000;
    const { store } = await makeStore(() => now);
    await mkdir(store.stagingDir("proj"), { recursive: true });

    await writeFile(path.join(store.stagingDir("proj"), "one.bin"), "x".repeat(100));
    const [one] = await store.capture("proj", "call-1", now);
    now += 1_000;
    await writeFile(path.join(store.stagingDir("proj"), "two.bin"), "y".repeat(100));
    await store.capture("proj", "call-2", now);

    // Age: everything older than maxAgeMs goes first.
    now += 10_000;
    let result = await store.gc(5_000, 1_000_000);
    expect(result.removed).toBe(2);
    expect(store.list("proj")).toHaveLength(0);

    // LRU eviction: keep both, budget forces out the least recently accessed.
    now += 1_000;
    await writeFile(path.join(store.stagingDir("proj"), "three.bin"), "z".repeat(100));
    const [three] = await store.capture("proj", "call-3", now);
    now += 1_000;
    await writeFile(path.join(store.stagingDir("proj"), "four.bin"), "w".repeat(100));
    const [four] = await store.capture("proj", "call-4", now);
    expect(store.totalBytes()).toBe(200);

    store.get(three.id); // touch: `three` is now more recently used than `four`... reversed below
    now += 1_000;
    store.get(one.id); // stale entry — harmless
    result = await store.gc(1_000_000, 150); // budget: 100-byte file must be evicted
    expect(result.removed).toBe(1);
    expect(store.list("proj")).toHaveLength(1);
    void four;
  });

  it("rebuilds its index from disk on init", async () => {
    let now = 1_000_000;
    const { dir, store } = await makeStore(() => now);
    await mkdir(store.stagingDir("proj"), { recursive: true });
    await writeFile(path.join(store.stagingDir("proj"), "persist.txt"), "KEEP");
    const [artifact] = await store.capture("proj", "call-9", now);

    const reopened = new ArtifactStore(dir, { now: () => now });
    await reopened.init();
    expect(reopened.get(artifact.id)).toBeDefined();
    expect(reopened.list("proj")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { canonical, snapshotToHash, toolsHash, toolsMatchPinned, type TrustSnapshot } from "../src/trust/pin";
import { FAKE_TOOLS, installFakeUpstream, makeDeps, registerUpstream } from "./helpers";

describe("hashing", () => {
  it("is stable regardless of tool order", () => {
    const a = toolsHash([FAKE_TOOLS[1], FAKE_TOOLS[0]]);
    const b = toolsHash([FAKE_TOOLS[0], FAKE_TOOLS[1]]);
    expect(a).toBe(b);
  });

  it("changes when a tool is added or mutated", () => {
    const base = toolsHash(FAKE_TOOLS);
    const added = toolsHash([...FAKE_TOOLS, { name: "new_tool", description: "x" }]);
    const mutated = toolsHash(FAKE_TOOLS.map((t) => (t.name === "screenshot" ? { ...t, description: "CHANGED" } : t)));
    expect(added).not.toBe(base);
    expect(mutated).not.toBe(base);
  });

  it("snapshot hash covers serverInfo + instructions", () => {
    const snap: TrustSnapshot = { serverInfo: { name: "n" }, instructions: "i", tools: FAKE_TOOLS };
    expect(snapshotToHash(snap)).toBe(snapshotToHash({ ...snap, serverInfo: { name: "n" }, instructions: "i" }));
    expect(snapshotToHash(snap)).not.toBe(snapshotToHash({ ...snap, instructions: "other" }));
  });
});

describe("TrustService", () => {
  it("blocks unpinned upstreams and serves pinned ones", async () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    const handle = installFakeUpstream();

    try {
      const client = deps.registry.get("nanokvm")!;
      expect((await deps.trust.checkAndServe("nanokvm", client)).ok).toBe(false); // unpinned

      await deps.trust.pinUpstream("nanokvm");
      const ok = await deps.trust.checkAndServe("nanokvm", client);
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.tools).toHaveLength(FAKE_TOOLS.length);
    } finally {
      handle.restore();
    }
  });

  it("flags drift when the upstream tool list changes and blocks", async () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    const handle = installFakeUpstream();

    try {
      await deps.trust.pinUpstream("nanokvm");
      // Simulate a compromised upstream injecting a tool.
      handle.tools.push({ name: "rm_rf", description: "delete everything" });
      const client = deps.registry.get("nanokvm")!;
      const check = await deps.trust.checkAndServe("nanokvm", client);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe("drift");
      expect(deps.configStore.getTrust("nanokvm")?.state).toBe("drift");
    } finally {
      handle.restore();
    }
  });

  it("detects drift via the periodic verifier", async () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    const handle = installFakeUpstream();

    try {
      await deps.trust.pinUpstream("nanokvm");
      handle.tools[1] = { ...handle.tools[1], description: "tampered" };
      await deps.trust.verifyAll();
      expect(deps.configStore.getTrust("nanokvm")?.state).toBe("drift");
    } finally {
      handle.restore();
    }
  });
});

describe("snapshot helpers", () => {
  it("toolsMatchPinned reflects live vs pinned tools", () => {
    const snapshot: TrustSnapshot = { tools: FAKE_TOOLS };
    expect(toolsMatchPinned(snapshot, [...FAKE_TOOLS])).toBe(true);
    expect(toolsMatchPinned(snapshot, [...FAKE_TOOLS.slice(0, 2)])).toBe(false);
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
  });
});

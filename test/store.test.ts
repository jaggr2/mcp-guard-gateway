import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection";
import { SqliteStore } from "../src/store/sqlite";
import { ConfigStore } from "../src/store/config";
import { SecretBox } from "../src/secrets";

describe("SqliteStore", () => {
  it("inserts and queries audit rows", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteStore(db);
    await store.insertAudit({
      caller_id: "alice",
      tool: "nanokvm_screenshot",
      args: "{}",
      reason: "need to see",
      decision: "auto-audited",
      upstream_status: "ok",
    });
    await store.insertAudit({ caller_id: "bob", tool: "nanokvm_click_mouse", args: "{}", reason: null, decision: "denied" });

    const all = await store.queryAudit({});
    expect(all).toHaveLength(2);
    expect(all[0].tool).toBe("nanokvm_click_mouse");
    const filtered = await store.queryAudit({ tool: "nanokvm_screenshot" });
    expect(filtered).toHaveLength(1);
  });

  it("runs the full approval lifecycle with the claim guard", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteStore(db);
    await store.createApproval({
      id: "a1",
      tool: "nanokvm_click_mouse",
      args: "{}",
      reason: "click",
      timeout_action: "deny",
      ttl_minutes: 30,
      created_at: new Date().toISOString(),
    });
    expect((await store.getApproval("a1"))?.status).toBe("pending");

    await store.setApprovalStatus("a1", "approved", { hermesUserId: "operator" });
    expect(await store.claimApprovalResult("a1", "__RUNNING__")).toBe(true);
    expect(await store.claimApprovalResult("a1", "__RUNNING__")).toBe(false);

    await store.setApprovalResult("a1", '{"content":[]}');
    expect((await store.getApproval("a1"))?.result).toBe('{"content":[]}');
  });
});

describe("ConfigStore", () => {
  it("upserts and deletes upstreams with cascading policies", () => {
    const db = openDatabase(":memory:");
    const cs = new ConfigStore(db);
    cs.upsertUpstream({
      id: "u1",
      namespace: "nanokvm",
      displayName: "NanoKVM",
      url: "https://nanokvm.example/mcp",
      protocolVersion: "2025-06-18",
      enabled: true,
      driftAction: "block",
      headerMap: { Authorization: "$SECRET:NANOKVM_API_KEY" },
    });
    expect(cs.getUpstream("nanokvm")?.url).toBe("https://nanokvm.example/mcp");
    cs.upsertPolicy({ upstream: "nanokvm", tool: "nanokvm_click_mouse", enabled: true, guard: "hitl", timeoutAction: "deny", ttlMinutes: 30 });
    expect(cs.getPolicy("nanokvm", "nanokvm_click_mouse")?.guard).toBe("hitl");
    cs.deleteUpstream("nanokvm");
    expect(cs.getUpstream("nanokvm")).toBeUndefined();
    expect(cs.listPolicies("nanokvm")).toHaveLength(0);
  });

  it("round-trips settings and clients", () => {
    const db = openDatabase(":memory:");
    const cs = new ConfigStore(db);
    cs.setSetting("example.setting", "value-123");
    expect(cs.getSetting("example.setting")).toBe("value-123");

    cs.upsertClient({ id: "c1", name: "opencode", secretHash: "abc", scopes: "mcp", enabled: true });
    expect(cs.getClient("c1")?.name).toBe("opencode");
    cs.deleteClient("c1");
    expect(cs.getClient("c1")).toBeUndefined();
  });
});

describe("SecretBox", () => {
  it("encrypts and decrypts secrets at rest", () => {
    const box = new SecretBox("master-key");
    const enc = box.encrypt("s3cr3t");
    expect(enc).not.toContain("s3cr3t");
    expect(box.decrypt(enc)).toBe("s3cr3t");
  });

  it("fails to decrypt with a different key", () => {
    const enc = new SecretBox("k1").encrypt("x");
    expect(() => new SecretBox("k2").decrypt(enc)).toThrow();
  });
});

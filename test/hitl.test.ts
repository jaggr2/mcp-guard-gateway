import { describe, expect, it } from "vitest";
import { checkApproval, startApproval } from "../src/guards/hitl";
import type { ResolvedPolicy } from "../src/policy";
import { installFakeUpstream, makeDeps, registerUpstream } from "./helpers";

const hitlPolicy: ResolvedPolicy = { enabled: true, guard: "hitl", timeout_action: "deny", ttl_minutes: 30 };
const approvePolicy: ResolvedPolicy = { enabled: true, guard: "hitl", timeout_action: "approve", ttl_minutes: 1 };

describe("startApproval", () => {
  it("creates a pending approval and posts the Hermes card", async () => {
    const deps = makeDeps();
    const started = await startApproval(deps, "nanokvm_click_mouse", { x: 10 }, "click it", hitlPolicy);

    expect(started.status).toBe("pending");
    const row = await deps.store.getApproval(started.approval_id);
    expect(row?.status).toBe("pending");
    expect(deps.hermes.cards).toHaveLength(1);
    expect(deps.hermes.cards[0].approvalId).toBe(started.approval_id);
    expect(row?.hermes_message_key).toBe("telegram:card:1");
  });
});

describe("checkApproval", () => {
  it("returns pending while awaiting the operator", async () => {
    const deps = makeDeps();
    const started = await startApproval(deps, "nanokvm_click_mouse", {}, "click", hitlPolicy);
    const result = await checkApproval(deps, started.approval_id);
    expect(JSON.parse(result.content[0].text as string).status).toBe("pending");
  });

  it("executes the upstream once on approval and serves it afterwards", async () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    const handle = installFakeUpstream();
    try {
      const started = await startApproval(deps, "nanokvm_click_mouse", { x: 10 }, "click", hitlPolicy);
      await deps.store.setApprovalStatus(started.approval_id, "approved", { hermesUserId: "operator" });

      const first = await checkApproval(deps, started.approval_id);
      expect(first.content[0].text).toBe("done:click_mouse");
      expect(handle.calls).toHaveLength(1);
      expect(handle.calls[0].name).toBe("click_mouse");
      expect(handle.calls[0].args).toEqual({ x: 10 });

      const second = await checkApproval(deps, started.approval_id);
      expect(second.content[0].text).toBe("done:click_mouse");
      expect(handle.calls).toHaveLength(1);

      const audit = (await deps.store.queryAudit({ tool: "nanokvm_click_mouse" }))[0];
      expect(audit.decision).toBe("approved");
      expect(audit.approved_by).toBe("operator");
    } finally {
      handle.restore();
    }
  });

  it("returns an error when denied", async () => {
    const deps = makeDeps();
    const started = await startApproval(deps, "nanokvm_click_mouse", {}, "click", hitlPolicy);
    await deps.store.setApprovalStatus(started.approval_id, "denied", { hermesUserId: "operator" });
    const result = await checkApproval(deps, started.approval_id);
    expect(result.isError).toBe(true);
  });

  it("expires with timeout_action deny without executing", async () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    const handle = installFakeUpstream();
    try {
      const started = await startApproval(deps, "nanokvm_click_mouse", {}, "click", hitlPolicy);
      deps.db
        .prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1000).toISOString(), started.approval_id);
      const result = await checkApproval(deps, started.approval_id);
      expect(result.isError).toBe(true);
      expect((await deps.store.getApproval(started.approval_id))?.status).toBe("expired");
      expect(handle.calls).toHaveLength(0);
    } finally {
      handle.restore();
    }
  });

  it("expires with timeout_action approve and executes", async () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    const handle = installFakeUpstream();
    try {
      const started = await startApproval(deps, "nanokvm_click_mouse", {}, "click", approvePolicy);
      deps.db
        .prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1000).toISOString(), started.approval_id);
      const result = await checkApproval(deps, started.approval_id);
      expect(result.content[0].text).toBe("done:click_mouse");
      expect(handle.calls).toHaveLength(1);
    } finally {
      handle.restore();
    }
  });
});

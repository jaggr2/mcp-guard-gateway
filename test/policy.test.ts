import { describe, expect, it } from "vitest";
import { injectReasonSchema, requiresReason, resolvePolicy, FAIL_CLOSED_DEFAULT } from "../src/policy";
import { enableTool, makeDeps, registerUpstream } from "./helpers";

describe("resolvePolicy", () => {
  it("fails closed by default (tool disabled until reviewed)", () => {
    const deps = makeDeps();
    const policy = resolvePolicy(deps.configStore, "nanokvm", "nanokvm_unknown");
    expect(policy).toEqual(FAIL_CLOSED_DEFAULT);
    expect(policy.enabled).toBe(false);
  });

  it("returns the explicit policy row when set", () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    enableTool(deps, "nanokvm", "nanokvm_click_mouse", "hitl");
    const policy = resolvePolicy(deps.configStore, "nanokvm", "nanokvm_click_mouse");
    expect(policy.enabled).toBe(true);
    expect(policy.guard).toBe("hitl");
    expect(policy.timeout_action).toBe("deny");
  });

  it("falls back to the upstream default when present", () => {
    const deps = makeDeps();
    registerUpstream(deps, "nanokvm");
    deps.configStore.upsertPolicy({ upstream: "nanokvm", tool: "*", enabled: true, guard: "reason", timeoutAction: null, ttlMinutes: null });
    expect(resolvePolicy(deps.configStore, "nanokvm", "nanokvm_something").guard).toBe("reason");
  });
});

describe("requiresReason / injectReasonSchema", () => {
  it("requires reason only for reason/hitl guards", () => {
    expect(requiresReason({ enabled: true, guard: "reason", timeout_action: null, ttl_minutes: null })).toBe(true);
    expect(requiresReason({ enabled: true, guard: "hitl", timeout_action: "deny", ttl_minutes: 30 })).toBe(true);
    expect(requiresReason({ enabled: true, guard: "none", timeout_action: null, ttl_minutes: null })).toBe(false);
  });

  it("injects the reason property into an object schema", () => {
    const next = injectReasonSchema({ type: "object", properties: { x: { type: "number" } }, required: ["x"] }) as Record<string, unknown>;
    expect((next.properties as Record<string, unknown>).reason).toBeDefined();
    expect(next.required).toEqual(["x", "reason"]);
  });

  it("passes through undefined schemas", () => {
    expect(injectReasonSchema(undefined)).toBeUndefined();
  });
});

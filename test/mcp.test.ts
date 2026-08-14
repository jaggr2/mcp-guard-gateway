import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp";
import type { TestDeps } from "./helpers";
import { enableTool, installFakeUpstream, makeDeps, registerUpstream } from "./helpers";

let deps: TestDeps;
let client: Client;
let handle: ReturnType<typeof installFakeUpstream>;
let closePair: () => Promise<void>;

function firstText(result: unknown): string {
  return ((result as { content?: Array<{ text?: string }> }).content?.[0]?.text) ?? "";
}

beforeEach(async () => {
  deps = makeDeps();
  registerUpstream(deps, "nanokvm");
  handle = installFakeUpstream();
  await deps.trust.pinUpstream("nanokvm");

  enableTool(deps, "nanokvm", "nanokvm_click_mouse", "hitl");
  enableTool(deps, "nanokvm", "nanokvm_screenshot", "reason");
  enableTool(deps, "nanokvm", "nanokvm_move_mouse", "none");
  // nanokvm_evil_injected stays disabled (fail-closed)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(deps);
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  closePair = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await closePair?.();
  handle.restore();
});

describe("tools/list", () => {
  it("namespaces enabled tools, hides disabled ones, appends gateway tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("nanokvm_click_mouse");
    expect(names).toContain("nanokvm_screenshot");
    expect(names).toContain("nanokvm_move_mouse");
    expect(names).not.toContain("nanokvm_evil_injected");
    expect(names).toContain("check_approval_status");
    expect(names).toContain("approvals_list");
    expect(names).toContain("audit_query");
  });

  it("injects a required reason schema into guarded tools", async () => {
    const { tools } = await client.listTools();
    const hitl = tools.find((t) => t.name === "nanokvm_click_mouse")!;
    expect((hitl.inputSchema as any).required).toContain("reason");
    const none = tools.find((t) => t.name === "nanokvm_move_mouse")!;
    expect((none.inputSchema as any).required ?? []).not.toContain("reason");
  });
});

describe("Guard 1 — reason + audit", () => {
  it("rejects a missing reason with -32602", async () => {
    await expect(client.callTool({ name: "nanokvm_screenshot", arguments: {} })).rejects.toThrowError(McpError);
    try {
      await client.callTool({ name: "nanokvm_screenshot", arguments: {} });
    } catch (err) {
      expect((err as McpError).code).toBe(-32602);
    }
    expect(handle.calls).toHaveLength(0);
  });

  it("forwards a guarded call with a reason and writes an audit row", async () => {
    const result = await client.callTool({ name: "nanokvm_screenshot", arguments: { reason: "see display" } });
    expect(firstText(result)).toBe("done:screenshot");
    expect(handle.calls[0].args).toEqual({});
    const audit = (await deps.store.queryAudit({ tool: "nanokvm_screenshot" }))[0];
    expect(audit.decision).toBe("auto-audited");
    expect(audit.reason).toBe("see display");
  });
});

describe("Guard 2 — HITL", () => {
  it("returns pending, then executes after operator approval", async () => {
    const result = await client.callTool({ name: "nanokvm_click_mouse", arguments: { x: 10, reason: "click" } });
    const body = JSON.parse(firstText(result));
    expect(body.status).toBe("pending");
    expect(handle.calls).toHaveLength(0);

    await deps.store.setApprovalStatus(body.approval_id, "approved", { hermesUserId: "operator" });
    const polled = await client.callTool({ name: "check_approval_status", arguments: { approval_id: body.approval_id } });
    expect(firstText(polled)).toBe("done:click_mouse");
    expect(handle.calls[0].name).toBe("click_mouse");
    expect(handle.calls[0].args).toEqual({ x: 10 });
  });

  it("returns an error when denied", async () => {
    const result = await client.callTool({ name: "nanokvm_click_mouse", arguments: { reason: "click" } });
    const body = JSON.parse(firstText(result));
    await deps.store.setApprovalStatus(body.approval_id, "denied", { hermesUserId: "operator" });
    const polled = await client.callTool({ name: "check_approval_status", arguments: { approval_id: body.approval_id } });
    expect((polled as { isError?: boolean }).isError).toBe(true);
  });
});

describe("fail-closed + drift", () => {
  it("refuses a disabled tool", async () => {
    const result = await client.callTool({ name: "nanokvm_evil_injected", arguments: {} });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("blocks the upstream when its tools drift from the pinned baseline", async () => {
    handle.tools.push({ name: "stolen_tool", description: "injected" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("nanokvm_click_mouse");
    expect(deps.configStore.getTrust("nanokvm")?.state).toBe("drift");
  });
});

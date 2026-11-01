/**
 * E2E smoke tests for the HITL approvals REST surface
 * (`POST /api/approvals`, `GET /api/approvals/:id`) — the contract used by the
 * OpenCode `credential-hitl` plugin (plugins/credential-hitl in this repo).
 *
 * Drives the real app over HTTP (`app.request`), the same way the plugin does:
 * create + poll with a sandbox token, decide through the existing operator
 * endpoints (resolve / latest-decision / decide). Also locks the generic
 * approval semantics in the MCP `check_approval_status` path (no upstream
 * execution) and that upstream approvals keep their exactly-once execution.
 */
import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { checkApproval, startGenericApproval } from "../src/guards/hitl";
import { makeDeps, trustedEnv } from "./helpers";

const BASE = "https://warden.jaggi.xyz";

function makeApp(): Hono {
  return createApp({
    DB_PATH: ":memory:",
    PUBLIC_URL: BASE,
    SECRET_MASTER_KEY: "test-master-key",
  });
}

/** Provisions a project and returns its sandbox token (like oc-<project>). */
async function provisionSandbox(app: Hono, slug: string): Promise<string> {
  const res = await app.request(
    `${BASE}/api/sandboxes`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Remote-Email": "roger@jaggi.xyz",
        "Remote-Groups": "admins",
      },
      body: JSON.stringify({ slug, displayName: slug, template: "minimal", dailyBudgetUsd: 5 }),
    },
    trustedEnv()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sandboxToken: string };
  expect(body.sandboxToken).toMatch(/^oc_/);
  return body.sandboxToken;
}

function createApproval(
  app: Hono,
  token: string,
  body: Record<string, unknown>
) {
  return app.request(`${BASE}/api/approvals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function pollApproval(app: Hono, token: string, id: string) {
  return app.request(`${BASE}/api/approvals/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function resolveApproval(
  app: Hono,
  id: string,
  action: "approve" | "deny",
  who = "roger@jaggi.xyz"
) {
  return app.request(
    `${BASE}/api/approvals/${id}/resolve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Remote-Email": who,
        "Remote-Groups": "operators",
      },
      body: JSON.stringify({ action }),
    },
    trustedEnv()
  );
}

describe("approvals REST e2e (OpenCode credential-hitl plugin contract)", () => {
  it("walks create -> poll -> approve -> poll with a sandbox token and operator decision", async () => {
    const app = makeApp();
    const token = await provisionSandbox(app, "cred-test");

    // 1. create — exactly what the plugin POSTs
    const createRes = await createApproval(app, token, {
      tool: "aws-deploy",
      reason: "deploy the stack",
      ttlMinutes: 30,
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      ok: boolean;
      approval_id: string;
      status: string;
      expires_at: string | null;
    };
    expect(created.ok).toBe(true);
    expect(created.approval_id).toMatch(/^apr_/);
    expect(created.status).toBe("pending");
    expect(created.expires_at).toBeTruthy();

    // 2. poll — the plugin reads `status`
    const poll1 = await pollApproval(app, token, created.approval_id);
    expect(poll1.status).toBe(200);
    const p1 = (await poll1.json()) as { status: string; tool: string; decided_by: string | null };
    expect(p1.status).toBe("pending");
    expect(p1.tool).toBe("aws-deploy");
    expect(p1.decided_by).toBeNull();

    // 3. a sandbox token must NOT be able to decide
    const forbidden = await app.request(`${BASE}/api/approvals/${created.approval_id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(forbidden.status).toBe(403);

    // 4. operator decides via the resolve endpoint
    const resolveRes = await resolveApproval(app, created.approval_id, "approve");
    expect(resolveRes.status).toBe(200);

    // 5. poll again -> approved
    const poll2 = await pollApproval(app, token, created.approval_id);
    const p2 = (await poll2.json()) as { status: string; decided_by: string | null };
    expect(p2.status).toBe("approved");
    expect(p2.decided_by).toBe("roger@jaggi.xyz");

    // 6. double decision is refused
    const again = await resolveApproval(app, created.approval_id, "deny");
    expect(again.status).toBe(409);
  });

  it("denies via the HA bridge's latest-decision endpoint", async () => {
    const app = makeApp();
    const token = await provisionSandbox(app, "cred-deny");
    const created = (await (await createApproval(app, token, {
      tool: "git:repo-token",
      reason: "push a fix",
    })).json()) as { approval_id: string };

    // ha-bridge.py posts {decision, approvalId, decidedBy} as operator
    const decideRes = await app.request(
      `${BASE}/api/approvals/latest-decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Remote-Email": "homeassistant@jaggi.xyz",
          "Remote-Groups": "operators",
        },
        body: JSON.stringify({ decision: "denied", approvalId: created.approval_id, decidedBy: "homeassistant" }),
      },
      trustedEnv()
    );
    expect(decideRes.status).toBe(200);

    const poll = await pollApproval(app, token, created.approval_id);
    const p = (await poll.json()) as { status: string; decided_by: string | null };
    expect(p.status).toBe("denied");
    expect(p.decided_by).toBe("homeassistant");
  });

  it("expires lazily without a human decision (ttlMinutes 0)", async () => {
    const app = makeApp();
    const token = await provisionSandbox(app, "cred-expiry");
    const created = (await (await createApproval(app, token, {
      tool: "aws-deploy",
      reason: "deploy",
      ttlMinutes: 0,
    })).json()) as { approval_id: string };

    const poll = await pollApproval(app, token, created.approval_id);
    expect(poll.status).toBe(200);
    const p = (await poll.json()) as { status: string };
    expect(p.status).toBe("expired");
  });

  it("validates the request body", async () => {
    const app = makeApp();
    const token = await provisionSandbox(app, "cred-validate");

    const noTool = await createApproval(app, token, { reason: "x" });
    expect(noTool.status).toBe(400);

    const noReason = await createApproval(app, token, { tool: "aws-deploy" });
    expect(noReason.status).toBe(400);

    const badTtl = await createApproval(app, token, { tool: "t", reason: "r", ttlMinutes: 12.5 });
    expect(badTtl.status).toBe(400);

    const badTtl2 = await createApproval(app, token, { tool: "t", reason: "r", ttlMinutes: 9999 });
    expect(badTtl2.status).toBe(400);
  });

  it("requires authentication and 404s unknown ids", async () => {
    const app = makeApp();
    const anonCreate = await app.request(`${BASE}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "t", reason: "r" }),
    });
    expect(anonCreate.status).toBe(401);

    const anonPoll = await app.request(`${BASE}/api/approvals/unknown-id`);
    expect(anonPoll.status).toBe(401);

    const token = await provisionSandbox(app, "cred-auth");
    const missing = await pollApproval(app, token, "apr_doesnotexist");
    expect(missing.status).toBe(404);
  });
});

describe("generic approvals in the MCP check_approval_status path", () => {
  it("resolves a generic approval without upstream execution", async () => {
    const deps = makeDeps();
    const started = await startGenericApproval(deps, {
      tool: "aws-deploy",
      reason: "deploy",
      args: { caller: "oc-server" },
      ttlMinutes: 30,
    });

    const pending = await checkApproval(deps, started.approval_id);
    const pendingJson = JSON.parse(String(pending.content[0]?.text));
    expect(pendingJson.status).toBe("pending");

    await deps.store.setApprovalStatus(started.approval_id, "approved", { hermesUserId: "roger" });
    const done = await checkApproval(deps, started.approval_id);
    expect(done.isError).toBeFalsy();
    const doneJson = JSON.parse(String(done.content[0]?.text));
    expect(doneJson.status).toBe("approved");
    expect(doneJson.approved_by).toBe("roger");

    // Idempotent: a repeat poll returns the stored result, not a re-execution.
    const again = await checkApproval(deps, started.approval_id);
    expect(JSON.parse(String(again.content[0]?.text)).status).toBe("approved");
  });

  it("keeps upstream approvals failing-closed when the upstream is gone", async () => {
    const deps = makeDeps();
    await deps.store.createApproval({
      id: "apr_upstream0001",
      tool: "nanokvm_click_mouse",
      args: JSON.stringify({ x: 1, y: 2 }),
      reason: "click",
      timeout_action: "deny",
      ttl_minutes: 30,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    await deps.store.setApprovalStatus("apr_upstream0001", "approved", { hermesUserId: "roger" });

    const result = await checkApproval(deps, "apr_upstream0001");
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain("Upstream execution failed");
  });
});

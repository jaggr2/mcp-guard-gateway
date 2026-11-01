import { APPROVAL_RUNNING_MARKER, type ApprovalRow } from "../store/types";
import type { CallToolResult } from "../types";
import { jsonResult, errorResult } from "../types";
import type { Deps } from "../deps";
import type { ResolvedPolicy } from "../policy";
import { recordAudit } from "./reason";

export interface StartedApproval {
  approval_id: string;
  status: "pending";
}

export function pendingResult(approvalId: string): CallToolResult {
  return jsonResult({
    approval_id: approvalId,
    status: "pending",
    hint: "Call check_approval_status(approval_id) until it resolves.",
  });
}

function isExpired(row: ApprovalRow): boolean {
  return row.expires_at !== null && Date.parse(row.expires_at) <= Date.now();
}

function upstreamName(deps: Deps, tool: string): string {
  const namespace = tool.split("_")[0];
  return tool.startsWith(`${namespace}_`) ? tool.slice(namespace.length + 1) : tool;
}

function summarize(result: CallToolResult): string {
  if (result.isError) {
    const first = result.content.find((block) => typeof block.text === "string");
    return `error: ${first?.text ?? "upstream reported failure"}`;
  }
  return "ok";
}

function parseResult(json: string): CallToolResult {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.content)) {
      return parsed as CallToolResult;
    }
    return jsonResult(parsed);
  } catch {
    return jsonResult(json);
  }
}

/**
 * Guard 2 entrypoint (async handleId pattern — never blocks the MCP request):
 * creates the approvals row, posts the Hermes card to the operator's Telegram DM,
 * and returns immediately. opencode polls `check_approval_status`.
 */
export async function startApproval(
  deps: Deps,
  tool: string,
  args: Record<string, unknown>,
  reason: string,
  policy: ResolvedPolicy
): Promise<StartedApproval> {
  const now = Date.now();
  const approvalId = crypto.randomUUID();
  // Default auto-expiry: 60 minutes, fail-closed (auto-deny) unless the policy says otherwise.
  const ttlMinutes = policy.ttl_minutes ?? 60;
  const timeoutAction = policy.timeout_action ?? "deny";
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();

  await deps.store.createApproval({
    id: approvalId,
    tool,
    args: JSON.stringify(args),
    reason,
    timeout_action: timeoutAction,
    ttl_minutes: ttlMinutes,
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  });

  const messageKey = await deps.hermes.sendApprovalCard(tool, reason, args, approvalId);
  if (messageKey !== null) {
    await deps.store.setApprovalHermesKey(approvalId, messageKey);
  }

  return { approval_id: approvalId, status: "pending" };
}

export interface GenericApprovalInput {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  /** Approval TTL in minutes (default 30). */
  ttlMinutes?: number;
  /** What happens without a human decision (default "deny", fail-closed). */
  timeoutAction?: "deny" | "approve";
}

/**
 * REST entry point for generic HITL approvals (e.g. the OpenCode
 * `credential-hitl` plugin): the approval itself is the outcome, nothing runs
 * upstream on approve. Mirrors `startApproval` (row + Hermes card, async
 * handleId pattern) and is picked up by the same HA card / Warden UI / decision
 * endpoints as MCP-guard approvals.
 */
export async function startGenericApproval(deps: Deps, input: GenericApprovalInput): Promise<StartedApproval> {
  const now = Date.now();
  const approvalId = `apr_${crypto.randomUUID().slice(0, 12)}`;
  const ttlMinutes = input.ttlMinutes ?? 30;
  const timeoutAction = input.timeoutAction ?? "deny";
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();

  await deps.store.createApproval({
    id: approvalId,
    kind: "generic",
    tool: input.tool,
    args: JSON.stringify(input.args),
    reason: input.reason,
    timeout_action: timeoutAction,
    ttl_minutes: ttlMinutes,
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  });

  const messageKey = await deps.hermes.sendApprovalCard(input.tool, input.reason, input.args, approvalId);
  if (messageKey !== null) {
    await deps.store.setApprovalHermesKey(approvalId, messageKey);
  }

  return { approval_id: approvalId, status: "pending" };
}

/**
 * Applies the lazy expiry bookkeeping for a pending row past its `expires_at`
 * (the timeout policy is snapshotted on the row at creation time) and returns
 * the row with an up-to-date status. Shared by the MCP poll (`checkApproval`)
 * and the REST status endpoint — neither path executes upstream work here.
 */
export async function settleExpiry(deps: Deps, row: ApprovalRow): Promise<ApprovalRow> {
  if (row.status !== "pending" || !isExpired(row)) {
    return row;
  }
  if (row.timeout_action === "approve") {
    await deps.store.setApprovalStatus(row.id, "approved");
    const updated: ApprovalRow = { ...row, status: "approved" };
    await notifyResolved(deps, updated);
    return updated;
  }
  await deps.store.setApprovalStatus(row.id, "expired");
  await recordAudit({ store: deps.store, callerId: deps.callerId }, row.tool, JSON.parse(row.args), row.reason, "expired", {
    expiresAt: row.expires_at,
  });
  await notifyResolved(deps, row);
  return { ...row, status: "expired" };
}

/**
 * Poll entry point: resolves a pending/approved approval, executing the upstream
 * call exactly once on approval. Returns the real upstream result on `approved`,
 * or an error result on `denied` / `expired`.
 */
export async function checkApproval(deps: Deps, approvalId: string): Promise<CallToolResult> {
  const row = await deps.store.getApproval(approvalId);
  if (!row) {
    return errorResult(`Approval not found: ${approvalId}`);
  }

  switch (row.status) {
    case "approved":
      return runApproved(deps, row);
    case "denied": {
      // Audit the denied attempt exactly once (claim pattern mirrors runApproved).
      const claimed = await deps.store.claimApprovalResult(row.id, "denied");
      if (claimed) {
        await recordAudit(
          { store: deps.store, callerId: deps.callerId },
          row.tool,
          JSON.parse(row.args),
          row.reason,
          "denied",
          { approvedBy: row.hermes_user_id, expiresAt: row.expires_at }
        );
      }
      return errorResult(`Approval ${approvalId} was denied by the operator`);
    }
    case "expired":
      return errorResult(`Approval ${approvalId} expired without approval`);
    case "pending": {
      const settled = await settleExpiry(deps, row);
      if (settled.status === "pending") {
        return pendingResult(approvalId);
      }
      if (settled.status === "approved") {
        return runApproved(deps, settled);
      }
      return errorResult(`Approval ${approvalId} expired without approval (timeout_action: deny)`);
    }
  }
}

async function runApproved(deps: Deps, row: ApprovalRow): Promise<CallToolResult> {
  if (row.result !== null && row.result !== APPROVAL_RUNNING_MARKER) {
    return parseResult(row.result);
  }

  const claimed = await deps.store.claimApprovalResult(row.id, APPROVAL_RUNNING_MARKER);
  if (!claimed) {
    const current = await deps.store.getApproval(row.id);
    if (current?.result && current.result !== APPROVAL_RUNNING_MARKER) {
      return parseResult(current.result);
    }
    return pendingResult(row.id);
  }

  let result: CallToolResult;
  if (row.kind === "generic") {
    // Generic (REST-created) approvals have no upstream call: the approval
    // itself is the outcome. The claim pattern above keeps polls exactly-once.
    result = jsonResult({ approval_id: row.id, status: "approved", approved_by: row.hermes_user_id });
  } else {
    try {
      const client = deps.registry.get(row.tool.split("_")[0]);
      if (!client) {
        throw new Error("upstream unavailable");
      }
      result = await client.callTool(upstreamName(deps, row.tool), JSON.parse(row.args), deps.callerId);
    } catch (err) {
      result = errorResult(
        `Upstream execution failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await deps.store.setApprovalResult(row.id, JSON.stringify(result));
  await recordAudit({ store: deps.store, callerId: deps.callerId }, row.tool, JSON.parse(row.args), row.reason, "approved", {
    approvedBy: row.hermes_user_id,
    upstreamStatus: summarize(result),
    expiresAt: row.expires_at,
  });
  return result;
}

/** Notifies the operator when an approval resolves (timeout path); swaps the pending card. */
async function notifyResolved(deps: Deps, row: ApprovalRow): Promise<void> {
  const status = row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "expired";
  await deps.hermes.sendResolutionCard(row.id, row.tool, row.reason, status);
}

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Store } from "../store/types";
import type { Decision, NewAuditRow } from "../store/types";

export interface AuditContext {
  store: Store;
  callerId: string;
}

/** Reads the `reason` argument the guard requires. */
export function extractReason(args: Record<string, unknown>): string | undefined {
  const value = args.reason;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Removes the guard-injected `reason` argument before forwarding upstream. */
export function stripReason(args: Record<string, unknown>): Record<string, unknown> {
  const { reason: _reason, ...rest } = args;
  return rest;
}

export function isValidReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.trim().length > 0;
}

/** Guard 1 precondition: missing/blank reason → JSON-RPC -32602 Invalid Params. */
export function assertReason(reason: string | undefined): void {
  if (!isValidReason(reason)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required argument "reason": why is this action needed?'
    );
  }
}

export interface RecordAuditOptions {
  approvedBy?: string | null;
  upstreamStatus?: string | null;
  expiresAt?: string | null;
}

export async function recordAudit(
  ctx: AuditContext,
  tool: string,
  args: Record<string, unknown>,
  reason: string | undefined,
  decision: Decision,
  opts: RecordAuditOptions = {}
): Promise<void> {
  const row: NewAuditRow = {
    caller_id: ctx.callerId,
    tool,
    args: JSON.stringify(args),
    reason: reason ?? null,
    decision,
    approved_by: opts.approvedBy ?? null,
    upstream_status: opts.upstreamStatus ?? null,
    expires_at: opts.expiresAt ?? null,
  };
  await ctx.store.insertAudit(row);
}

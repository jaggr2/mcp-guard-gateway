import type { Deps } from "../deps";
import type { CallToolResult, Tool } from "../types";
import { errorResult, jsonResult } from "../types";
import { checkApproval } from "../guards/hitl";

/** Gateway-native tools exposed alongside the namespaced upstream tools. */
export const GATEWAY_TOOLS: Tool[] = [
  {
    name: "check_approval_status",
    description:
      "Poll the outcome of a human-in-the-loop approval. Returns { approval_id, status: pending|approved|denied|expired }. " +
      "On approved, executes the upstream call and returns its real result; pending means wait and retry.",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: {
          type: "string",
          description: "Approval id returned by a guarded tools/call.",
        },
      },
      required: ["approval_id"],
    },
  },
  {
    name: "approvals_list",
    description: "List HITL approvals, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "approved", "denied", "expired"],
          description: "Filter by approval status. Omit to list all.",
        },
      },
    },
  },
  {
    name: "audit_query",
    description: "Query the immutable audit log. Returns calls with tool, reason, decision, caller.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Filter by namespaced tool name." },
        since: { type: "string", description: "ISO-8601 timestamp; only rows at or after this." },
        caller_id: { type: "string", description: "Filter by caller identity." },
        limit: { type: "number", description: "Max rows to return (default 100)." },
      },
    },
  },
];

export const GATEWAY_TOOL_NAMES = new Set(GATEWAY_TOOLS.map((tool) => tool.name));

export async function callGatewayTool(
  deps: Deps,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (name) {
    case "check_approval_status": {
      const approvalId = args.approval_id;
      if (typeof approvalId !== "string" || approvalId.length === 0) {
        return errorResult('Missing required argument "approval_id"');
      }
      return checkApproval(deps, approvalId);
    }
    case "approvals_list": {
      const status = args.status;
      const approvals = await deps.store.listApprovals(
        status === undefined ? undefined : (status as "pending" | "approved" | "denied" | "expired")
      );
      return jsonResult({
        approvals: approvals.map((row) => ({
          approval_id: row.id,
          tool: row.tool,
          status: row.status,
          reason: row.reason,
          created_at: row.created_at,
          expires_at: row.expires_at,
        })),
      });
    }
    case "audit_query": {
      const rows = await deps.store.queryAudit({
        tool: typeof args.tool === "string" ? args.tool : undefined,
        since: typeof args.since === "string" ? args.since : undefined,
        caller_id: typeof args.caller_id === "string" ? args.caller_id : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return jsonResult({ rows });
    }
    default:
      return errorResult(`Unknown gateway tool: ${name}`);
  }
}

import type { Deps } from "../deps";
import type { CallToolResult, Tool } from "../types";
import { errorResult, jsonResult } from "../types";
import { checkApproval } from "../guards/hitl";
import { processLearningProposal } from "../memory/learning";
import { SecretBox } from "../secrets";

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
  {
    name: "warden_propose_learning",
    description:
      "Persist a reusable engineering gotcha, domain memory, or SKILL.md update into the central jaggr2/agent-memory repository so all OpenCode sandboxes benefit.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["gotcha", "memory", "skill"],
          description: "Classification of the learning.",
        },
        target_path: {
          type: "string",
          description: "Relative path in jaggr2/agent-memory (e.g. 'memories/aws-cdk-gotchas.md' or 'skills/my-skill/SKILL.md').",
        },
        title: {
          type: "string",
          description: "Concise heading/title of the lesson or skill.",
        },
        content: {
          type: "string",
          description: "Markdown body to append (or full SKILL.md content when mode='replace').",
        },
        mode: {
          type: "string",
          enum: ["append", "replace"],
          description: "Whether to append a section to target_path (default) or replace the file.",
        },
        rationale: {
          type: "string",
          description: "Why this learning is reusable across sessions/projects.",
        },
      },
      required: ["kind", "target_path", "title", "content"],
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
    case "warden_propose_learning": {
      const kind = args.kind as "gotcha" | "memory" | "skill";
      const targetPath = typeof args.target_path === "string" ? args.target_path : "";
      const title = typeof args.title === "string" ? args.title : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!targetPath || !title || !content) {
        return errorResult("Missing required fields: kind, target_path, title, content");
      }

      const secretBox = new SecretBox(deps.config.masterKey);
      const decryptedSecrets: string[] = [];
      for (const ct of deps.configStore.listSecretCiphertexts()) {
        try {
          decryptedSecrets.push(secretBox.decrypt(ct));
        } catch {
          /* ignore */
        }
      }

      const res = processLearningProposal(
        deps.configStore,
        deps.config.agentMemoryDir,
        {
          sourceProject: deps.callerId || "unknown",
          kind: kind === "skill" || kind === "memory" ? kind : "gotcha",
          targetPath,
          title,
          content,
          mode: args.mode === "replace" ? "replace" : "append",
          rationale: typeof args.rationale === "string" ? args.rationale : undefined,
        },
        decryptedSecrets
      );

      if (!res.ok) {
        return errorResult(res.error);
      }
      await deps.hermes.notify(
        `🧠 New learning recorded from '${deps.callerId}': ${title} (${res.learning.targetPath})`
      );
      return jsonResult({
        ok: true,
        learning_id: res.learning.id,
        target_path: res.learning.targetPath,
        commit_ref: res.learning.commitRef,
        status: res.learning.status,
      });
    }
    default:
      return errorResult(`Unknown gateway tool: ${name}`);
  }
}

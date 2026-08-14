import type { ConfigStore, PolicyRow } from "./store/config";

export type Guard = "none" | "reason" | "hitl";

export interface ResolvedPolicy {
  enabled: boolean;
  guard: Guard;
  timeout_action: "deny" | "approve" | null;
  ttl_minutes: number | null;
}

/**
 * Fail-closed default: a tool with no policy row is NOT served until an admin
 * explicitly enables it (and picks guards) in the UI. This complements trust
 * pinning — a hijacked upstream that injects a new tool can't have it enabled.
 */
export const FAIL_CLOSED_DEFAULT: ResolvedPolicy = {
  enabled: false,
  guard: "none",
  timeout_action: null,
  ttl_minutes: null,
};

export const REASON_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "Why is this action needed.",
} as const;

/**
 * Resolves the effective policy for a tool: explicit row → upstream default
 * (`*`) → fail-closed default.
 */
export function resolvePolicy(configStore: ConfigStore, upstream: string, tool: string): ResolvedPolicy {
  const specific = configStore.getPolicy(upstream, tool);
  if (specific) {
    return toResolved(specific);
  }
  const fallback = configStore.getPolicy(upstream, "*");
  if (fallback) {
    return toResolved(fallback);
  }
  return FAIL_CLOSED_DEFAULT;
}

export function requiresReason(policy: ResolvedPolicy): boolean {
  return policy.guard === "reason" || policy.guard === "hitl";
}

function toResolved(row: PolicyRow): ResolvedPolicy {
  return {
    enabled: row.enabled,
    guard: row.guard,
    timeout_action: row.timeoutAction,
    ttl_minutes: row.ttlMinutes,
  };
}

/**
 * Adds a required `reason` string property to a tool's input schema so guarded
 * tools advertise the argument to clients.
 */
export function injectReasonSchema(inputSchema: unknown): unknown {
  if (typeof inputSchema !== "object" || inputSchema === null) {
    return inputSchema;
  }
  const schema = inputSchema as Record<string, unknown>;
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const nextRequired = required.includes("reason") ? required : [...required, "reason"];
  return {
    ...schema,
    type: "object",
    properties: { ...properties, reason: REASON_SCHEMA },
    required: nextRequired,
  };
}

import type { ProjectRow } from "../store/config";
import type { CallToolResult } from "../types";

/**
 * MCP Security Fortress Guards:
 * 1. Per-project upstream ACLs (`allowed_upstreams`)
 * 2. Repo-boundary parameter guard (`owner == "jaggr2"`, `repo == project.slug`)
 * 3. Outbound secret & high-entropy token leak scanner
 * 4. Inbound prompt-injection & hidden Unicode tag sanitizer
 * 5. Per-project runaway tool-call loop circuit breaker
 */

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS Access Key ID", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub Token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/ },
  { name: "GitHub Fine-Grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "Private Key PEM", re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "Anthropic/OpenAI Key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/ },
];

const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "system-reminder tag", re: /<\s*\/?\s*system-reminder\b[^>]*>/gi },
  { name: "ignore previous instructions", re: /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/gi },
  { name: "invisible unicode tags", re: /[\u{E0000}-\u{E007F}]/gu },
];

/** 1. Checks if a project sandbox is allowed to see/call a given MCP upstream namespace. */
export function isUpstreamAllowedForProject(
  project: ProjectRow | undefined,
  upstreamNamespace: string
): boolean {
  if (!project) return true; // non-sandbox admin/OIDC caller
  const raw = (project.allowedUpstreams || "*").trim();
  if (raw === "*") return true;
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(upstreamNamespace.toLowerCase()) || allowed.includes("*");
}

/** 2. Enforces repo boundary on GitHub MCP tools when called by a project sandbox. */
export function enforceRepoBoundary(
  project: ProjectRow | undefined,
  toolName: string,
  args: Record<string, unknown>,
  expectedOwner = "jaggr2"
): { ok: true } | { ok: false; reason: string } {
  if (!project) return { ok: true };
  if (!toolName.toLowerCase().startsWith("github_")) return { ok: true };

  if (typeof args.owner === "string" && args.owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    return {
      ok: false,
      reason: `[Warden Repo Guard] Sandbox '${project.slug}' cannot access owner '${args.owner}' (must be '${expectedOwner}')`,
    };
  }
  if (
    typeof args.repo === "string" &&
    args.repo.toLowerCase() !== project.slug.toLowerCase() &&
    args.repo.toLowerCase() !== "agent-memory"
  ) {
    return {
      ok: false,
      reason: `[Warden Repo Guard] Sandbox '${project.slug}' cannot mutate repository '${args.repo}'`,
    };
  }
  return { ok: true };
}

/** 3. Scans outbound tool arguments (or learning payloads) for leaked secrets. */
export function scanOutboundSecrets(
  payload: unknown,
  knownDecryptedSecrets: string[] = []
): { ok: true } | { ok: false; match: string } {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(serialized)) {
      return { ok: false, match: pat.name };
    }
  }
  for (const secret of knownDecryptedSecrets) {
    if (secret && secret.length >= 12 && serialized.includes(secret)) {
      return { ok: false, match: "Stored gateway secret value" };
    }
  }
  return { ok: true };
}

/** 4. Sanitizes inbound MCP tool responses against indirect prompt injection. */
export function sanitizeInboundToolResult(result: CallToolResult): {
  result: CallToolResult;
  sanitizedFlags: string[];
} {
  const flags = new Set<string>();
  const cleanContent = result.content.map((block) => {
    if (typeof block.text !== "string") return block;
    let text = block.text;
    for (const pat of INJECTION_PATTERNS) {
      if (pat.re.test(text)) {
        flags.add(pat.name);
        text = text.replace(pat.re, `[WARDEN-REDACTED:${pat.name}]`);
      }
      pat.re.lastIndex = 0;
    }
    return { ...block, text };
  });
  return {
    result: { ...result, content: cleanContent },
    sanitizedFlags: [...flags],
  };
}

/** 5. Per-caller tool-call velocity & identical-failure loop circuit breaker. */
interface CallerWindow {
  timestamps: number[];
  lastFailedKey: string | null;
  consecutiveFailures: number;
}

export class LoopCircuitBreaker {
  private windows = new Map<string, CallerWindow>();

  constructor(
    private maxCallsPerMinute = 30,
    private maxConsecutiveIdenticalFailures = 5
  ) {}

  checkBeforeCall(
    callerId: string,
    toolName: string,
    args: Record<string, unknown>,
    nowMs = Date.now()
  ): { ok: true } | { ok: false; reason: string } {
    const win = this.getOrInit(callerId);
    const cutoff = nowMs - 60_000;
    win.timestamps = win.timestamps.filter((t) => t > cutoff);

    if (win.timestamps.length >= this.maxCallsPerMinute) {
      return {
        ok: false,
        reason: `[Warden Circuit Breaker] Rate limit exceeded (${this.maxCallsPerMinute} calls/min) for '${callerId}'`,
      };
    }

    const callKey = `${toolName}:${JSON.stringify(args)}`;
    if (win.lastFailedKey === callKey && win.consecutiveFailures >= this.maxConsecutiveIdenticalFailures) {
      return {
        ok: false,
        reason: `[Warden Circuit Breaker] Blocked runaway loop: '${toolName}' failed ${win.consecutiveFailures} times consecutively with identical arguments`,
      };
    }

    win.timestamps.push(nowMs);
    return { ok: true };
  }

  recordOutcome(
    callerId: string,
    toolName: string,
    args: Record<string, unknown>,
    isError: boolean
  ): void {
    const win = this.getOrInit(callerId);
    const callKey = `${toolName}:${JSON.stringify(args)}`;
    if (isError) {
      if (win.lastFailedKey === callKey) {
        win.consecutiveFailures += 1;
      } else {
        win.lastFailedKey = callKey;
        win.consecutiveFailures = 1;
      }
    } else if (win.lastFailedKey === callKey) {
      win.lastFailedKey = null;
      win.consecutiveFailures = 0;
    }
  }

  private getOrInit(callerId: string): CallerWindow {
    let w = this.windows.get(callerId);
    if (!w) {
      w = { timestamps: [], lastFailedKey: null, consecutiveFailures: 0 };
      this.windows.set(callerId, w);
    }
    return w;
  }
}

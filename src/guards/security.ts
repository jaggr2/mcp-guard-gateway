import type { ProjectRow } from "../store/config";
import type { CallToolResult } from "../types";

/**
 * MCP Security Fortress Guards:
 * 1. Per-project upstream ACLs (`allowed_upstreams`)
 * 2. Repo-boundary parameter guard (`owner == "jaggr2"`, `repo == project.slug`)
 * 3. Browser-boundary parameter guard (Browser Broker URL scheme/private/domain policy)
 * 4. Outbound secret & high-entropy token leak scanner
 * 5. Inbound prompt-injection & hidden Unicode tag sanitizer
 * 6. Per-project runaway tool-call loop circuit breaker
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

/** Splits a CSV config value into lowercased, trimmed, non-empty entries. */
function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Matches the browser navigation tools the boundary applies to: namespaced
 * `*_browser_navigate`, `*_browser_goto` and `*_devtools_navigate_page` calls
 * (arg `url`), plus `*_browser_tabs` when it opens a tab (`action: "open"`).
 */
function matchBrowserNav(
  toolName: string,
  args: Record<string, unknown>
): { matched: true; url: unknown } | { matched: false } {
  const lower = toolName.toLowerCase();
  if (
    lower.endsWith("browser_navigate") ||
    lower.endsWith("browser_goto") ||
    lower.endsWith("devtools_navigate_page")
  ) {
    return { matched: true, url: args.url };
  }
  if (lower.endsWith("browser_tabs") && args.action === "open") {
    return { matched: true, url: args.url };
  }
  return { matched: false };
}

/** Literal private/loopback/link-local IP check (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10). */
function isPrivateIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  const isV4 = (ip: string): boolean => {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return isV4(bare);
  if (!bare.includes(":")) return false;
  const mappedV4 = bare.slice(bare.lastIndexOf(":") + 1); // ::ffff:127.0.0.1 style
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(mappedV4)) return isV4(mappedV4);
  if (bare === "::1") return true;
  const head = parseInt(bare.split(":")[0] || "0", 16);
  return (head >= 0xfc00 && head <= 0xfdff) || (head >= 0xfe80 && head <= 0xfebf);
}

/** Private/loopback IP literals, `localhost`, and `*.internal` / `*.lan` hostnames. */
function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare.endsWith(".internal") ||
    bare.endsWith(".lan") ||
    isPrivateIpLiteral(bare)
  );
}

/** 3. Enforces the browser boundary (Browser Broker) on navigation tools: http/https
 * only, no literal private/loopback/internal destinations (unless allowlisted in the
 * project's `browserInternalTargets`), then the project's `browserAllowedDomains`
 * policy (`*` = any domain, `''` = any non-private domain, else CSV of exact domains
 * or `*.suffix` wildcards). Non-navigation tools pass through untouched. */
export function enforceBrowserBoundary(
  project: ProjectRow | undefined,
  toolName: string,
  args: Record<string, unknown>
): { ok: true } | { ok: false; reason: string } {
  const nav = matchBrowserNav(toolName, args);
  if (!nav.matched) return { ok: true };

  const who = project ? `Sandbox '${project.slug}'` : "Caller";
  const raw = nav.url;
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason: `[Warden Browser Guard] ${who} called '${toolName}' without a valid 'url' argument`,
    };
  }
  const denyUrl = (detail: string): { ok: false; reason: string } => ({
    ok: false,
    reason: `[Warden Browser Guard] ${who} cannot navigate to '${raw}': ${detail}`,
  });

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return denyUrl("not a valid absolute URL");
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return denyUrl(`scheme '${scheme.replace(/:$/, "")}' is not allowed (only http and https)`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const hostPort = parsed.host.toLowerCase().replace(/^\[|\]$/g, "");
  const isTarget = (entry: string): boolean =>
    entry === hostname || entry === hostPort || entry === parsed.hostname.toLowerCase();

  if (!splitCsv(project?.browserInternalTargets).some(isTarget) && isPrivateHost(hostname)) {
    return denyUrl(
      `'${hostname}' is a private/loopback destination — add it to browserInternalTargets to allow`
    );
  }

  const policy = (project?.browserAllowedDomains ?? "").trim().toLowerCase();
  if (policy === "*" || policy === "") return { ok: true }; // '' = any non-private destination
  const domainOk = splitCsv(policy).some((entry) =>
    entry.startsWith("*.") ? hostname.endsWith(entry.slice(1)) : isTarget(entry)
  );
  if (!domainOk) {
    return denyUrl(
      `domain '${hostname}' is not in browserAllowedDomains — add it (or a '*.suffix' wildcard) to allow`
    );
  }
  return { ok: true };
}

/** 4. Scans outbound tool arguments (or learning payloads) for leaked secrets. */
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

/** 5. Sanitizes inbound MCP tool responses against indirect prompt injection. */
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

/** 6. Per-caller tool-call velocity & identical-failure loop circuit breaker. */
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

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { GatewayConfig } from "../config";
import type { ConfigStore } from "../store/config";
import { verifyWithIssuers } from "./verify";
import { hashToken, isTrustedPeer, normalizeAddr } from "./peer";

export interface AuthContext {
  authInfo?: AuthInfo;
  callerId: string;
  groups: string[];
}

function splitGroups(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

/** Validates a gateway-issued machine service token or project sandbox token. */
function verifyServiceToken(
  configStore: ConfigStore,
  token: string
): { clientId: string; name: string; scopes: string[] } | null {
  const hash = hashToken(token);
  for (const client of configStore.listClients()) {
    if (client.enabled && client.secretHash === hash) {
      return {
        clientId: client.id,
        name: client.name,
        scopes: client.scopes.split(/[\s,]+/).filter(Boolean),
      };
    }
  }
  const project = configStore.getProjectByTokenHash(hash);
  if (project) {
    configStore.touchProjectActivity(project.slug);
    return {
      clientId: `sandbox:${project.slug}`,
      name: project.slug,
      scopes: ["mcp", "llm", "sandbox"],
    };
  }
  return null;
}

/**
 * Resolves a Bearer service/sandbox token to an AuthContext with scope-mapped
 * groups (`admin` → admin groups, `operator` → operator groups). Null when the
 * token is not a known service or project token.
 */
export function authenticateServiceToken(
  request: Request,
  config: GatewayConfig,
  configStore: ConfigStore
): AuthContext | null {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) return null;
  const service = verifyServiceToken(configStore, token);
  if (!service) return null;
  const groups = service.scopes.includes("admin")
    ? [...config.adminGroups]
    : service.scopes.includes("operator")
      ? [...config.operatorGroups]
      : [];
  return {
    authInfo: {
      token,
      clientId: service.clientId,
      scopes: service.scopes,
      type: "service",
    } as unknown as AuthInfo,
    callerId: service.name,
    groups,
  };
}

/**
 * Authenticates an /mcp request. When OIDC issuers are configured, a valid
 * Bearer token is REQUIRED (OIDC JWT, gateway service token, or project sandbox token);
 * otherwise the request is treated as anonymous (dev mode) with the forward-auth
 * identity header as the caller id — but only when the TCP peer is a trusted
 * ingress. Identity headers from anywhere else are spoofable and ignored.
 */
export async function authenticateMcp(
  request: Request,
  config: GatewayConfig,
  configStore?: ConfigStore,
  peer = ""
): Promise<AuthContext> {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;

  if (token) {
    const verified = await verifyWithIssuers(config.issuers, token);
    if (verified) {
      const claims = verified.claims;
      const clientId =
        typeof claims.azp === "string"
          ? claims.azp
          : typeof claims.client_id === "string"
            ? claims.client_id
            : "unknown";
      return {
        authInfo: {
          token,
          clientId,
          scopes: [],
          sub: verified.sub,
          email: verified.email,
          groups: verified.groups,
        } as unknown as AuthInfo,
        callerId: verified.email ?? verified.sub,
        groups: verified.groups,
      };
    }
    if (configStore) {
      const service = verifyServiceToken(configStore, token);
      if (service) {
        return {
          authInfo: {
            token,
            clientId: service.clientId,
            scopes: service.scopes,
            type: "service",
          } as unknown as AuthInfo,
          callerId: service.name,
          groups: [],
        };
      }
    }
    if (config.issuers.length > 0) {
      return { callerId: "unauthenticated", groups: [] };
    }
  }

  if (config.issuers.length > 0 && !token) {
    return { callerId: "unauthenticated", groups: [] };
  }

  const callerId = request.headers.get(config.identityHeader) ?? "anonymous";
  const groups = splitGroups(request.headers.get(config.groupsHeader));
  if ((callerId !== "anonymous" || groups.length > 0) && !isTrustedPeer(peer, config.trustedIdentityPeers)) {
    console.warn(`[warden-auth] MCP identity headers ignored from untrusted peer ${normalizeAddr(peer) || "unknown"}`);
    return { callerId: "anonymous", groups: [] };
  }
  return { callerId, groups };
}

/**
 * Authenticates admin API requests. Two accepted proofs:
 *   1. A gateway service token (`Authorization: Bearer …`) with `admin`/`operator`
 *      scope — used by host tooling and automation.
 *   2. Forward-auth identity headers (`Remote-Email`/`Remote-Groups`), but ONLY
 *      from a trusted ingress peer (the reverse proxy). Any other peer could
 *      spoof those headers over plain HTTP.
 */
export function authenticateAdmin(
  request: Request,
  config: GatewayConfig,
  configStore?: ConfigStore,
  peer = ""
): AuthContext | null {
  if (configStore) {
    const viaToken = authenticateServiceToken(request, config, configStore);
    if (viaToken) return viaToken;
  }
  const callerId = request.headers.get(config.identityHeader);
  if (!callerId) {
    return null;
  }
  if (!isTrustedPeer(peer, config.trustedIdentityPeers)) {
    console.warn(`[warden-auth] admin identity headers for ${callerId} ignored from untrusted peer ${normalizeAddr(peer) || "unknown"}`);
    return null;
  }
  const groups = splitGroups(request.headers.get(config.groupsHeader));
  return { callerId, groups };
}

export function isAdmin(ctx: AuthContext, config: GatewayConfig): boolean {
  return ctx.groups.some((g) => config.adminGroups.includes(g));
}

export function isOperator(ctx: AuthContext, config: GatewayConfig): boolean {
  return ctx.groups.some((g) => [...config.adminGroups, ...config.operatorGroups].includes(g));
}

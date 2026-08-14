import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { GatewayConfig } from "../config";
import type { ConfigStore } from "../store/config";
import { verifyWithIssuers } from "./verify";

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

/** Validates a gateway-issued machine service token against the clients table. */
function verifyServiceToken(configStore: ConfigStore, token: string): { clientId: string; name: string; scopes: string[] } | null {
  const hash = createHash("sha256").update(token).digest("hex");
  for (const client of configStore.listClients()) {
    if (client.enabled && client.secretHash === hash) {
      return { clientId: client.id, name: client.name, scopes: client.scopes.split(/[\s,]+/).filter(Boolean) };
    }
  }
  return null;
}

/**
 * Authenticates an /mcp request. When OIDC issuers are configured, a valid
 * Bearer token is REQUIRED (OIDC JWT or gateway service token); otherwise the
 * request is treated as anonymous (dev mode) with the forward-auth identity
 * header as the caller id.
 */
export async function authenticateMcp(
  request: Request,
  config: GatewayConfig,
  configStore?: ConfigStore
): Promise<AuthContext> {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;

  if (token) {
    const verified = await verifyWithIssuers(config.issuers, token);
    if (verified) {
      const claims = verified.claims;
      const clientId =
        typeof claims.azp === "string" ? claims.azp : typeof claims.client_id === "string" ? claims.client_id : "unknown";
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
  return { callerId, groups };
}

/**
 * Authenticates admin API requests. These sit behind the reverse proxy's
 * forward-auth (Authelia), which sets the identity/group headers. When those are
 * absent we 401 (the proxy must be the only ingress).
 */
export function authenticateAdmin(request: Request, config: GatewayConfig): AuthContext | null {
  const callerId = request.headers.get(config.identityHeader);
  if (!callerId) {
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

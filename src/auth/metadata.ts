import type { GatewayConfig } from "../config";

/**
 * RFC 9728 protected-resource metadata. Served at
 * `/.well-known/oauth-protected-resource` so MCP clients discover the
 * authorization servers and start the OAuth dance.
 */
export function protectedResourceMetadata(config: GatewayConfig) {
  return {
    resource: `${config.publicUrl}/mcp`,
    authorization_servers: config.issuers.map((i) => i.issuer),
    scopes_supported: ["openid", "profile", "email", "groups"],
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 8414 authorization-server metadata. Served at the gateway's
 * `/.well-known/oauth-authorization-server`, pointing at the external IdP
 * (Authelia). No `registration_endpoint` — Authelia does not support DCR, so
 * clients fall back to their pre-registered client.
 */
export function authServerMetadata(config: GatewayConfig) {
  const first = config.issuers[0];
  if (!first) {
    return null;
  }
  return {
    issuer: first.issuer,
    authorization_endpoint: `${first.issuer}/api/oidc/authorization`,
    token_endpoint: `${first.issuer}/api/oidc/token`,
    jwks_uri: first.jwksUrl,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "email", "groups"],
  };
}

/** 401 challenge header directing MCP clients to the protected-resource metadata. */
export function bearerChallenge(config: GatewayConfig): Headers {
  const headers = new Headers();
  headers.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`
  );
  return headers;
}

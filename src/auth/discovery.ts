export interface OidcDiscovery {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  response_types_supported?: string[];
}

const cache = new Map<string, { at: number; promise: Promise<OidcDiscovery> }>();
const TTL_MS = 10 * 60_000;

/**
 * Fetches (and caches) an OIDC provider's discovery document. Used so the
 * gateway tracks the IdP's real endpoints (jwks_uri, userinfo_endpoint,
 * authorization/token endpoints) instead of hardcoding provider paths.
 */
export async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  const discoveryUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const cached = cache.get(discoveryUrl);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.promise;
  }
  const promise = (async () => {
    const response = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`OIDC discovery failed: HTTP ${response.status}`);
    }
    return (await response.json()) as OidcDiscovery;
  })();
  cache.set(discoveryUrl, { at: Date.now(), promise });
  return promise;
}

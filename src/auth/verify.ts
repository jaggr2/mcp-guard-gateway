import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IssuerConfig } from "../config";
import { fetchDiscovery } from "./discovery";

export interface VerifiedUser {
  sub: string;
  email?: string;
  groups: string[];
  claims: Record<string, unknown>;
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/**
 * Verifies access tokens issued by a configured OIDC issuer (e.g. Authelia).
 * The jwks_uri + userinfo_endpoint are resolved from the issuer's discovery
 * document (cached) unless explicitly overridden. JWT signature is verified
 * against the issuer's JWKS; user claims (email, groups) come from userinfo.
 */
export class IssuerVerifier {
  private jwksCache?: ReturnType<typeof createRemoteJWKSet>;
  private endpointsCache?: { jwksUrl: string; userinfoUrl: string };

  constructor(private config: IssuerConfig) {}

  private async endpoints(): Promise<{ jwksUrl: string; userinfoUrl: string }> {
    if (this.config.jwksUrl && this.config.userinfoUrl) {
      return { jwksUrl: this.config.jwksUrl, userinfoUrl: this.config.userinfoUrl };
    }
    if (this.endpointsCache) {
      return this.endpointsCache;
    }
    const discovery = await fetchDiscovery(this.config.issuer);
    this.endpointsCache = {
      jwksUrl: this.config.jwksUrl ?? discovery.jwks_uri ?? `${this.config.issuer}/jwks.json`,
      userinfoUrl: this.config.userinfoUrl ?? discovery.userinfo_endpoint ?? `${this.config.issuer}/api/oidc/userinfo`,
    };
    return this.endpointsCache;
  }

  private async jwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    return (this.jwksCache ??= createRemoteJWKSet(new URL((await this.endpoints()).jwksUrl)));
  }

  async verify(token: string): Promise<VerifiedUser | null> {
    let payload: { sub?: string; [key: string]: unknown };
    try {
      const result = await jwtVerify(token, await this.jwks(), {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      payload = result.payload as { sub?: string; [key: string]: unknown };
    } catch {
      return null;
    }

    const sub = payload.sub;
    if (!sub) {
      return null;
    }

    let email: string | undefined;
    let groups: string[] = [];
    try {
      const { userinfoUrl } = await this.endpoints();
      const response = await fetch(userinfoUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) {
        const info = (await response.json()) as { email?: string; groups?: string[] };
        email = info.email;
        if (Array.isArray(info.groups)) {
          groups = info.groups.map(String);
        }
      }
    } catch {
      // userinfo is best-effort; JWT signature is the hard gate
    }

    return { sub, email, groups, claims: payload };
  }
}

/** Resolves a Bearer token against every configured issuer. */
export async function verifyWithIssuers(
  issuers: IssuerConfig[],
  token: string
): Promise<VerifiedUser | null> {
  for (const issuer of issuers) {
    const verified = await new IssuerVerifier(issuer).verify(token);
    if (verified) {
      return verified;
    }
  }
  return null;
}

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IssuerConfig } from "../config";

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
 * JWT signature is checked against the issuer's JWKS; user claims (email,
 * groups) are fetched from the standard userinfo endpoint with the token.
 */
export class IssuerVerifier {
  private jwksCache?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private config: IssuerConfig) {}

  private get jwks(): ReturnType<typeof createRemoteJWKSet> {
    return (this.jwksCache ??= createRemoteJWKSet(new URL(this.config.jwksUrl)));
  }

  async verify(token: string): Promise<VerifiedUser | null> {
    let payload: { sub?: string; [key: string]: unknown };
    try {
      const result = await jwtVerify(token, this.jwks, {
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
      const response = await fetch(this.config.userinfoUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
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

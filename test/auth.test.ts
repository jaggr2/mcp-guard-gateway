import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config";
import { openDatabase } from "../src/db/connection";
import { ConfigStore } from "../src/store/config";
import { authenticateMcp } from "../src/auth/middleware";
import { IssuerVerifier } from "../src/auth/verify";
import { protectedResourceMetadata } from "../src/auth/metadata";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let pubJwk: Record<string, unknown>;
let privateKey: CryptoKey;

function pemToBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

beforeEach(async () => {
  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicCryptoKey = await crypto.subtle.importKey(
    "spki",
    pemToBuffer(pubPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );
  privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBuffer(privPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );
  pubJwk = await exportJWK(publicCryptoKey);

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/oidc/jwks") {
      res.end(JSON.stringify({ keys: [{ ...pubJwk, kid: "k1", alg: "RS256", use: "sig" }] }));
    } else if (url.pathname === "/api/oidc/userinfo") {
      res.end(JSON.stringify({ sub: "roger", email: "roger@jaggi.xyz", groups: ["admins", "operators"] }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

async function signToken(): Promise<string> {
  return new SignJWT({ azp: "opencode-mcp" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`${baseUrl}`)
    .setAudience("https://mcp-guard.example")
    .setSubject("roger")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("IssuerVerifier", () => {
  it("verifies a valid JWT and fetches userinfo claims", async () => {
    const verifier = new IssuerVerifier({
      issuer: baseUrl,
      jwksUrl: `${baseUrl}/api/oidc/jwks`,
      userinfoUrl: `${baseUrl}/api/oidc/userinfo`,
      audience: "https://mcp-guard.example",
    });
    const verified = await verifier.verify(await signToken());
    expect(verified?.sub).toBe("roger");
    expect(verified?.email).toBe("roger@jaggi.xyz");
    expect(verified?.groups).toContain("admins");
  });

  it("rejects a token for the wrong audience", async () => {
    const verifier = new IssuerVerifier({
      issuer: baseUrl,
      jwksUrl: `${baseUrl}/api/oidc/jwks`,
      userinfoUrl: `${baseUrl}/api/oidc/userinfo`,
      audience: "https://other.example",
    });
    expect(await verifier.verify(await signToken())).toBeNull();
  });

  it("rejects a garbage token", async () => {
    const verifier = new IssuerVerifier({
      issuer: baseUrl,
      jwksUrl: `${baseUrl}/api/oidc/jwks`,
      userinfoUrl: `${baseUrl}/api/oidc/userinfo`,
      audience: "https://mcp-guard.example",
    });
    expect(await verifier.verify("not.a.jwt")).toBeNull();
  });
});

describe("authenticateMcp", () => {
  it("requires a valid bearer when issuers are configured", async () => {
    const config = loadConfig(
      { AUTHELIA_ISSUER: baseUrl, AUTHELIA_AUDIENCE: "https://mcp-guard.example" },
      null
    );
    expect(config.issuers).toHaveLength(1);

    const anonymous = await authenticateMcp(new Request("https://mcp-guard.example/mcp"), config);
    expect(anonymous.callerId).toBe("unauthenticated");

    const authed = await authenticateMcp(
      new Request("https://mcp-guard.example/mcp", { headers: { Authorization: `Bearer ${await signToken()}` } }),
      config
    );
    expect(authed.callerId).toBe("roger@jaggi.xyz");
    expect(authed.groups).toContain("admins");
  });

  it("falls back to forward-auth headers when no issuer is configured", async () => {
    const config = loadConfig({}, null);
    const ctx = await authenticateMcp(
      new Request("https://mcp-guard.example/mcp", {
        headers: { "Remote-Email": "alice@example.com", "Remote-Groups": "operators" },
      }),
      config
    );
    expect(ctx.callerId).toBe("alice@example.com");
  });

  it("accepts a gateway machine service token", async () => {
    const config = loadConfig({}, null);
    const db = openDatabase(":memory:");
    const configStore = new ConfigStore(db);
    const token = "supersecrettoken";
    configStore.upsertClient({
      id: "c1",
      name: "opencode",
      secretHash: createHash("sha256").update(token).digest("hex"),
      scopes: "mcp",
      enabled: true,
    });

    const ctx = await authenticateMcp(
      new Request("https://mcp-guard.example/mcp", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      config,
      configStore
    );
    expect(ctx.callerId).toBe("opencode");
    expect(ctx.authInfo?.clientId).toBe("c1");

    const bad = await authenticateMcp(
      new Request("https://mcp-guard.example/mcp", {
        headers: { Authorization: "Bearer wrong" },
      }),
      config,
      configStore
    );
    expect(bad.callerId).toBe("anonymous");
  });
});

describe("protectedResourceMetadata", () => {
  it("exposes the resource and authorization servers", () => {
    const config = loadConfig({ AUTHELIA_ISSUER: "https://auth.jaggi.xyz" }, null);
    const meta = protectedResourceMetadata(config);
    expect(meta.resource).toBe("http://127.0.0.1:8080/mcp");
    expect(meta.authorization_servers).toEqual(["https://auth.jaggi.xyz"]);
  });
});

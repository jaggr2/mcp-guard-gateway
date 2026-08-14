import type { ConfigStore, UpstreamRow } from "../store/config";
import { SecretBox } from "../secrets";
import { UpstreamClientImpl, type UpstreamClient, type UpstreamConfig } from "./client";

const SECRET_REF = /^\$SECRET:(.+)$/;

/**
 * Loads configured upstreams from the DB and builds ready-to-use clients with
 * secrets resolved from the encrypted `secrets` table.
 */
export class UpstreamRegistry {
  private readonly clients = new Map<string, UpstreamClient>();

  constructor(
    private config: ConfigStore,
    private secrets: SecretBox
  ) {}

  private resolveHeaderValue(value: string): string {
    const match = SECRET_REF.exec(value);
    if (!match) {
      return value;
    }
    const ciphertext = this.config.getSecret(match[1]);
    if (!ciphertext) {
      throw new Error(`Secret "${match[1]}" is not configured`);
    }
    return this.secrets.decrypt(ciphertext);
  }

  /** Returns all enabled upstream clients (fresh from DB). */
  list(): UpstreamClient[] {
    return this.config
      .listUpstreams()
      .filter((up) => up.enabled)
      .map((up) => this.build(up));
  }

  /** Returns an upstream client by namespace, or undefined if disabled/unknown. */
  get(namespace: string): UpstreamClient | undefined {
    const row = this.config.getUpstream(namespace);
    if (!row || !row.enabled) {
      return undefined;
    }
    return this.build(row);
  }

  getOrNull(namespace: string): UpstreamClient | null {
    return this.get(namespace) ?? null;
  }

  private build(row: UpstreamRow): UpstreamClient {
    const cacheKey = `${row.namespace}:${row.updatedAt}`;
    const cached = this.clients.get(cacheKey);
    if (cached) {
      return cached;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(row.headerMap)) {
      headers[name] = this.resolveHeaderValue(value);
    }
    const config: UpstreamConfig = {
      namespace: row.namespace,
      displayName: row.displayName,
      url: row.url,
      protocolVersion: row.protocolVersion,
      headers,
    };
    const client = new UpstreamClientImpl(config);
    this.clients.set(cacheKey, client);
    return client;
  }
}

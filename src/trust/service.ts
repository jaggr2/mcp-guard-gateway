import type { ConfigStore } from "../store/config";
import type { UpstreamRegistry } from "../upstream/registry";
import type { UpstreamClient, UpstreamTool } from "../upstream/client";
import { snapshotToHash, snapshotToolsHash, toolsMatchPinned, type TrustSnapshot } from "./pin";

export type CheckResult =
  | { ok: true; tools: UpstreamTool[] }
  | { ok: false; reason: "unpinned" | "drift" | "error" };

export interface DriftNotifier {
  notify(upstream: string, message: string): Promise<void>;
}

/**
 * Trust service: pins a baseline snapshot per upstream, verifies live tools on
 * every `tools/list` (request path), and enforces the configured drift action.
 */
export class TrustService {
  constructor(
    private config: ConfigStore,
    private registry: UpstreamRegistry,
    private onDrift?: DriftNotifier
  ) {}

  /** Snapshots the upstream and pins it as the baseline. Throws if unreachable. */
  async pinUpstream(namespace: string): Promise<TrustSnapshot> {
    const client = this.registry.get(namespace);
    if (!client) {
      throw new Error(`Upstream "${namespace}" not found or disabled`);
    }
    const snapshot = await client.snapshot();
    this.config.upsertTrust({
      upstream: namespace,
      pinnedHash: snapshotToHash(snapshot),
      snapshot: JSON.stringify(snapshot),
      pinnedAt: new Date().toISOString(),
      state: "ok",
    });
    return snapshot;
  }

  /** Enforces pinning during tools/list. Never contacts the upstream when already flagged. */
  async checkAndServe(namespace: string, client: UpstreamClient): Promise<CheckResult> {
    const trust = this.config.getTrust(namespace);
    if (!trust) {
      return { ok: false, reason: "unpinned" };
    }
    if (trust.state === "drift" || trust.state === "error") {
      return { ok: false, reason: trust.state };
    }
    let live: UpstreamTool[];
    try {
      const res = await client.toolsList();
      live = res.tools;
    } catch {
      return { ok: false, reason: "error" };
    }
    const snapshot: TrustSnapshot = JSON.parse(trust.snapshot);
    if (toolsMatchPinned(snapshot, live)) {
      return { ok: true, tools: live };
    }
    await this.markDrift(namespace, snapshot);
    return { ok: false, reason: "drift" };
  }

  /** Re-snapshots every upstream and updates its state (periodic background job). */
  async verifyAll(): Promise<void> {
    for (const client of this.registry.list()) {
      try {
        const snapshot = await client.snapshot();
        const current = this.config.getTrust(client.namespace);
        if (!current) {
          // Not pinned yet — leave as-is; fail-closed tools/list gate handles it.
          continue;
        }
        if (snapshotToHash(snapshot) === current.pinnedHash) {
          if (current.state !== "ok") {
            this.config.upsertTrust({ ...current, state: "ok" });
          }
        } else {
          this.config.upsertTrust({ ...current, state: "drift" });
          void this.onDrift?.notify(
            client.namespace,
            `⚠️ Upstream \`${client.namespace}\` drifted from its pinned baseline. Tools are blocked until re-pinned.`
          );
        }
      } catch {
        const current = this.config.getTrust(client.namespace);
        if (current) {
          this.config.upsertTrust({ ...current, state: "error" });
        }
      }
    }
  }

  private async markDrift(namespace: string, snapshot: TrustSnapshot): Promise<void> {
    const current = this.config.getTrust(namespace);
    this.config.upsertTrust({
      upstream: namespace,
      pinnedHash: current?.pinnedHash ?? "",
      snapshot: JSON.stringify(snapshot),
      pinnedAt: current?.pinnedAt ?? new Date().toISOString(),
      state: "drift",
    });
    void this.onDrift?.notify(
      namespace,
      `⚠️ Upstream \`${namespace}\`'s tool list changed vs. its pinned baseline. Blocked until re-pinned.`
    );
  }
}

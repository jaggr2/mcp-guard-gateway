import { createHash } from "node:crypto";
import type { UpstreamTool } from "../upstream/client";

/** Canonical, key-sorted JSON serialization so semantically-equal snapshots hash identically. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

const TOOL_FIELDS = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

function pinTool(tool: UpstreamTool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of TOOL_FIELDS) {
    const value = tool[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

export interface TrustSnapshot {
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  tools: UpstreamTool[];
}

/** Hash over the full baseline (serverInfo + instructions + tools). */
export function snapshotToHash(snapshot: TrustSnapshot): string {
  return sha256(canonical(snapshot));
}

/** Hash over the tools list alone (fast, request-path comparison). */
export function toolsHash(tools: UpstreamTool[]): string {
  const pinned = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(pinTool);
  return sha256(canonical(pinned));
}

export function snapshotToolsHash(snapshot: TrustSnapshot): string {
  return toolsHash(snapshot.tools ?? []);
}

/** True when the live tools match the pinned baseline. */
export function toolsMatchPinned(snapshot: TrustSnapshot, liveTools: UpstreamTool[]): boolean {
  return snapshotToolsHash(snapshot) === toolsHash(liveTools);
}

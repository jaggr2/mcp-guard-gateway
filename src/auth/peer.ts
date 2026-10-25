import { createHash } from "node:crypto";

/** Normalizes socket addresses (`::ffff:10.0.0.1` → `10.0.0.1`). */
export function normalizeAddr(addr: string | undefined | null): string {
  if (!addr) return "";
  const a = addr.trim().toLowerCase();
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/**
 * True when `addr` matches `entry` — an exact address, `*`, or an IPv4 CIDR.
 * IPv6 entries match exactly (plus the `::ffff:` normalization above).
 */
export function addrMatches(addr: string, entry: string): boolean {
  const a = normalizeAddr(addr);
  const e = entry.trim().toLowerCase();
  if (!a || !e) return false;
  if (e === "*") return true;
  if (!e.includes("/")) return a === e;
  const [net, bitsStr] = e.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(a);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * True when the request's TCP peer is a trusted ingress (reverse proxy / local).
 * Identity headers (`Remote-*`) are only honored from these peers — anyone else
 * could otherwise spoof an admin identity over plain HTTP.
 */
export function isTrustedPeer(addr: string, trusted: string[]): boolean {
  return trusted.some((entry) => addrMatches(addr, entry));
}

/** Fingerprint helper for token comparisons (sha256 hex). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

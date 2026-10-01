import { BlockList, isIP } from "node:net";

export interface TargetPolicyOptions {
  /** Lab/dev exception: allow 127.0.0.0/8 and ::1 (e.g. the local mock). Off by default. */
  allowLoopback: boolean;
  /** Explicit allow-list. When set it REPLACES the default private LAN ranges. */
  allowCidrs?: readonly string[];
}

/** Default allow-list: private LAN ranges where cameras live. Public addresses are not targets. */
export const DEFAULT_ALLOW_CIDRS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"] as const;

/** Never allowed, whatever the allow-list says (cloud metadata, link-local, multicast, unspecified). */
const ALWAYS_DENIED = [
  "0.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255/32",
  "100.100.100.200/32", // Alibaba metadata
  "168.63.129.16/32", // Azure wire server
  "::/128",
  "fe80::/10",
  "ff00::/8",
  "fd00:ec2::254/128", // AWS IPv6 metadata
] as const;
const LOOPBACK = ["127.0.0.0/8", "::1/128"] as const;

function toList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split("/");
    const family = isIP(addr ?? "") === 6 ? "ipv6" : "ipv4";
    list.addSubnet(addr as string, Number(bits), family);
  }
  return list;
}
const denied = toList(ALWAYS_DENIED);
const loopback = toList(LOOPBACK);

/** Throws on a malformed CIDR (used to validate configuration). */
export function validateCidrs(cidrs: readonly string[]): void {
  for (const c of cidrs) {
    const [addr, bits] = c.split("/");
    const v = isIP(addr ?? "");
    const max = v === 4 ? 32 : v === 6 ? 128 : -1;
    if (max < 0 || !Number.isInteger(Number(bits)) || Number(bits) < 0 || Number(bits) > max) {
      throw new Error(`invalid CIDR in target allow-list: ${JSON.stringify(c)}`);
    }
  }
}

/** `::ffff:a.b.c.d` and `::ffff:aabb:ccdd` -> dotted IPv4; otherwise unchanged. */
function unmapV4(h: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
  if (dotted) return dotted[1] as string;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return h;
}

/**
 * Where the API may dial for a device. IP literals only (no DNS => no rebinding).
 * Order: always-denied > loopback (only with explicit flag) > explicit allow-list (default: private LAN).
 */
export function checkTarget(host: string, opts: TargetPolicyOptions): { allowed: boolean; reason?: string } {
  const raw = host.replace(/^\[|\]$/g, "");
  if (isIP(raw) === 0) return { allowed: false, reason: "host must be a canonical IP address" };
  const h = unmapV4(raw.toLowerCase());
  const family = isIP(h) === 6 ? "ipv6" : "ipv4";
  if (denied.check(h, family)) return { allowed: false, reason: "address class is never allowed" };
  if (loopback.check(h, family)) {
    return opts.allowLoopback
      ? { allowed: true }
      : { allowed: false, reason: "loopback requires the lab exception" };
  }
  const allow = toList(opts.allowCidrs?.length ? opts.allowCidrs : DEFAULT_ALLOW_CIDRS);
  return allow.check(h, family)
    ? { allowed: true }
    : { allowed: false, reason: "outside the allowed target ranges" };
}

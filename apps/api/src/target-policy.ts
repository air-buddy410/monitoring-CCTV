import { isIP } from "node:net";

export interface TargetPolicyOptions {
  allowLoopback: boolean;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

/**
 * Where the API may dial for a device. IP literals only (no DNS => no rebinding).
 * Link-local (incl. cloud metadata 169.254.169.254), unspecified, multicast/broadcast are
 * always refused; loopback only when explicitly enabled (tests / local mock).
 */
export function checkTarget(host: string, opts: TargetPolicyOptions): { allowed: boolean; reason?: string } {
  const h = host.replace(/^\[|\]$/g, "");
  const version = isIP(h);
  if (version === 0) return { allowed: false, reason: "host must be an IP address" };
  if (version === 4) {
    const n = ipv4ToInt(h);
    const inRange = (base: string, bits: number) => n >>> (32 - bits) === ipv4ToInt(base) >>> (32 - bits);
    if (n === 0 || inRange("0.0.0.0", 8)) return { allowed: false, reason: "unspecified" };
    if (inRange("169.254.0.0", 16)) return { allowed: false, reason: "link-local" };
    if (inRange("224.0.0.0", 4) || n === 0xffffffff) return { allowed: false, reason: "multicast/broadcast" };
    if (inRange("127.0.0.0", 8) && !opts.allowLoopback) return { allowed: false, reason: "loopback" };
    return { allowed: true };
  }
  const l = h.toLowerCase();
  if (l === "::" || l === "0:0:0:0:0:0:0:0") return { allowed: false, reason: "unspecified" };
  if (/^fe[89ab]/.test(l)) return { allowed: false, reason: "link-local" };
  if (l.startsWith("ff")) return { allowed: false, reason: "multicast" };
  if ((l === "::1" || l === "0:0:0:0:0:0:0:1") && !opts.allowLoopback)
    return { allowed: false, reason: "loopback" };
  if (l.startsWith("::ffff:")) return checkTarget(l.slice(7), opts); // IPv4-mapped
  return { allowed: true };
}

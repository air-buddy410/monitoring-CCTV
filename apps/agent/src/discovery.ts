import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { isIP } from "node:net";
import { checkTarget } from "@pantau/adapters";

/** WS-Discovery over UDP multicast (PRD section 4.5, step 3). Read-only: one Probe out, answers in. */
export const DISCOVERY_DEFAULTS = {
  target: "239.255.255.250",
  port: 3702,
  /** Link-local only: probes never cross a router. */
  multicastTtl: 1,
  timeoutMs: 3000,
  maxResults: 64,
} as const;

const MAX_DATAGRAM_BYTES = 16 * 1024;
const MAX_XADDRS = 8;
const MAX_SCOPES = 32;

export function buildProbe(): { messageId: string; xml: string } {
  const messageId = `urn:uuid:${randomUUID()}`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
    `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
    `<e:Header><w:MessageID>${messageId}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    `<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>` +
    `<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
  return { messageId, xml };
}

export interface ProbeMatch {
  endpointId: string;
  types: string[];
  scopes: string[];
  xaddrs: string[];
}
export interface ParsedProbeMatches {
  relatesTo: string | null;
  matches: ProbeMatch[];
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? (m[1] as string).trim() : null;
};

/**
 * Pulls the few fields a Probe answer has. It is not an XML parser on purpose: a DOCTYPE or entity declaration is
 * refused before anything else, so there is no entity expansion and no external fetch to defend against.
 */
export function parseProbeMatches(xml: string): ParsedProbeMatches {
  const empty: ParsedProbeMatches = { relatesTo: null, matches: [] };
  if (xml.length === 0 || xml.length > MAX_DATAGRAM_BYTES) return empty;
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) return empty;
  const relatesTo = tag(xml, "RelatesTo");
  const matches: ProbeMatch[] = [];
  for (const block of xml.matchAll(/<(?:\w+:)?ProbeMatch>([\s\S]*?)<\/(?:\w+:)?ProbeMatch>/g)) {
    const body = block[1] as string;
    const split = (s: string | null, cap: number) => (s ? s.split(/\s+/).filter(Boolean).slice(0, cap) : []);
    matches.push({
      endpointId: (tag(body, "Address") ?? "").slice(0, 100),
      types: split(tag(body, "Types"), 8),
      scopes: split(tag(body, "Scopes"), MAX_SCOPES),
      xaddrs: split(tag(body, "XAddrs"), MAX_XADDRS),
    });
  }
  return { relatesTo, matches };
}

/** Text from a scope value: decoded, control characters and angle brackets removed, capped. */
function clean(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    s = raw;
  }
  s = s
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 64);
  return s.length > 0 ? s : undefined;
}
const scopeValue = (scopes: string[], key: string) =>
  clean(
    scopes
      .find((s) => s.toLowerCase().startsWith(`onvif://www.onvif.org/${key}/`))
      ?.split("/")
      .slice(4)
      .join("/"),
  );

export interface Candidate {
  host: string;
  port: number;
  xaddr: string;
  endpointId: string;
  name?: string;
  hardware?: string;
  location?: string;
}

export interface DiscoverOptions {
  target?: string;
  port?: number;
  timeoutMs?: number;
  maxResults?: number;
  /** Local interface address to send from (default: the OS chooses). */
  bindAddress?: string;
  allowLoopback: boolean;
  allowCidrs?: readonly string[];
}

/** An XAddr is trusted only if it is plain http to a literal IP that is the sender itself and passes the target policy. */
function acceptXAddr(
  xaddr: string,
  sender: string,
  o: DiscoverOptions,
): { host: string; port: number; xaddr: string } | null {
  let u: URL;
  try {
    u = new URL(xaddr);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) === 0 || host !== sender) return null;
  if (!checkTarget(host, { allowLoopback: o.allowLoopback, allowCidrs: o.allowCidrs }).allowed) return null;
  const port = u.port ? Number(u.port) : 80;
  return { host, port, xaddr: `http://${host}:${port}${u.pathname}`.slice(0, 200) };
}

/** Send one Probe and collect the answers that really answer it and really come from the device they describe. */
export function discover(o: DiscoverOptions): Promise<Candidate[]> {
  const target = o.target ?? DISCOVERY_DEFAULTS.target;
  const port = o.port ?? DISCOVERY_DEFAULTS.port;
  const timeoutMs = o.timeoutMs ?? DISCOVERY_DEFAULTS.timeoutMs;
  const max = o.maxResults ?? DISCOVERY_DEFAULTS.maxResults;
  const probe = buildProbe();
  const found = new Map<string, Candidate>();

  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: false });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(
        [...found.values()]
          .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }) || a.port - b.port)
          .slice(0, max),
      );
    };
    const timer = setTimeout(finish, timeoutMs);

    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      if (msg.length === 0 || msg.length > MAX_DATAGRAM_BYTES) return;
      const parsed = parseProbeMatches(msg.toString("utf8"));
      if (parsed.relatesTo !== probe.messageId) return;
      for (const m of parsed.matches) {
        if (!m.types.some((t) => /NetworkVideoTransmitter$/.test(t))) continue;
        const ok = m.xaddrs.map((x) => acceptXAddr(x, rinfo.address, o)).find((x) => x !== null);
        if (!ok) continue;
        const key = `${ok.host}:${ok.port}`;
        if (found.has(key) || found.size >= max) continue;
        found.set(key, {
          ...ok,
          endpointId: m.endpointId,
          name: scopeValue(m.scopes, "name"),
          hardware: scopeValue(m.scopes, "hardware"),
          location: scopeValue(m.scopes, "location"),
        });
      }
    });
    sock.bind(0, o.bindAddress, () => {
      try {
        if (/^22[4-9]\.|^23\d\./.test(target)) sock.setMulticastTTL(DISCOVERY_DEFAULTS.multicastTtl);
      } catch {
        // not a multicast-capable interface; the send below reports the real problem
      }
      sock.send(probe.xml, port, target, (err) => {
        if (err) finish();
      });
    });
  });
}

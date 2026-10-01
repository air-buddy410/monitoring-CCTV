import { createHash, randomBytes } from "node:crypto";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Parse a `WWW-Authenticate: Digest ...` header. Basic (plaintext) challenges are refused. */
export function parseDigestChallenge(header: string): DigestChallenge {
  if (!/^\s*Digest\s/i.test(header)) throw new Error("device did not offer Digest authentication");
  const params: Record<string, string> = {};
  for (const m of header.replace(/^\s*Digest\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    params[(m[1] ?? "").toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  if (!params.realm || !params.nonce) throw new Error("malformed Digest challenge");
  return {
    realm: params.realm,
    nonce: params.nonce,
    ...(params.qop ? { qop: params.qop } : {}),
    ...(params.opaque ? { opaque: params.opaque } : {}),
    ...(params.algorithm ? { algorithm: params.algorithm } : {}),
  };
}

function hash(algorithm: string, data: string): string {
  const alg = algorithm.toUpperCase().startsWith("SHA-256") ? "sha256" : "md5";
  return createHash(alg).update(data).digest("hex");
}

export function buildDigestAuthorization(args: {
  challenge: DigestChallenge;
  username: string;
  password: string;
  method: string;
  uri: string;
  cnonce?: string;
  nc?: number;
}): string {
  const { challenge: c, username, password, method, uri } = args;
  const algorithm = c.algorithm ?? "MD5";
  const ha1 = hash(algorithm, `${username}:${c.realm}:${password}`);
  const ha2 = hash(algorithm, `${method}:${uri}`);
  const qop = c.qop
    ?.split(",")
    .map((s) => s.trim())
    .includes("auth")
    ? "auth"
    : undefined;
  const cnonce = args.cnonce ?? randomBytes(8).toString("hex");
  const nc = (args.nc ?? 1).toString(16).padStart(8, "0");
  const response = qop
    ? hash(algorithm, `${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(algorithm, `${ha1}:${c.nonce}:${ha2}`);
  const parts = [
    `username="${username.replace(/["\\]/g, "")}"`,
    `realm="${c.realm}"`,
    `nonce="${c.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algorithm}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

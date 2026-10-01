import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Identity {
  apiUrl: string;
  agentId: string;
  siteId: string;
  /** Long-lived, revocable. Kept only in a 0600 file. */
  agentToken: string;
  name: string;
  publicKey: string;
}

export class EnrollError extends Error {
  constructor(readonly code: string) {
    super(`enrollment failed: ${code}`);
    this.name = "EnrollError";
  }
}

const IDENTITY = "identity.json";
const PRIVATE_KEY = "agent.key";

function writeSecret(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function loadIdentity(dir: string): Identity | null {
  const path = join(dir, IDENTITY);
  if (!existsSync(path)) return null;
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(`${IDENTITY} must be mode 0600 (no access for group or others)`);
  return JSON.parse(readFileSync(path, "utf8")) as Identity;
}

export interface EnrollOptions {
  apiUrl: string;
  /** One-time token from the NOC. Used for one request and never written to disk or logs. */
  enrollToken: string;
  name: string;
  dir: string;
  hostname?: string;
  agentVersion?: string;
  fetchFn?: typeof fetch;
}

/** Create the key pair, register with the cloud, keep the long-lived token. */
export async function enroll(o: EnrollOptions): Promise<Identity> {
  if (!/^pae_[A-Za-z0-9_-]{43}$/.test(o.enrollToken)) throw new EnrollError("enrollment_token_malformed");
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  chmodSync(o.dir, 0o700);
  if (existsSync(join(o.dir, IDENTITY))) throw new EnrollError("already_enrolled");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const apiUrl = o.apiUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await (o.fetchFn ?? fetch)(`${apiUrl}/v1/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Enroll ${o.enrollToken}` },
      body: JSON.stringify({
        name: o.name,
        publicKey: publicKeyB64,
        ...(o.hostname ? { hostname: o.hostname } : {}),
        ...(o.agentVersion ? { agentVersion: o.agentVersion } : {}),
      }),
    });
  } catch {
    throw new EnrollError("network_error");
  }
  if (res.status !== 201) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code === "string") code = body.code;
    } catch {
      // not JSON: keep the status-based code
    }
    throw new EnrollError(code);
  }
  const body = (await res.json()) as { agentId: string; siteId: string; agentToken: string };
  const identity: Identity = {
    apiUrl,
    agentId: body.agentId,
    siteId: body.siteId,
    agentToken: body.agentToken,
    name: o.name,
    publicKey: publicKeyB64,
  };
  writeSecret(join(o.dir, PRIVATE_KEY), privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  writeSecret(join(o.dir, IDENTITY), JSON.stringify(identity));
  return identity;
}

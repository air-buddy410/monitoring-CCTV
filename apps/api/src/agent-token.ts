import { createHash, randomBytes } from "node:crypto";

/** Enrollment tokens embed the org and enrollment id so an unauthenticated agent can be routed to its tenant. */
const ENROLLMENT_PREFIX = "enr";
const AGENT_PREFIX = "agt";
const ID_RE = /^[A-Za-z0-9_-]+$/;

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** `enr.<orgId>.<enrollmentId>.<secret>` — the secret half is what proves possession; only its hash is stored. */
export function newEnrollmentToken(orgId: string, enrollmentId: string): string {
  return `${ENROLLMENT_PREFIX}.${orgId}.${enrollmentId}.${secret()}`;
}

export function parseEnrollmentToken(token: string): { orgId: string; enrollmentId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [prefix, orgId, enrollmentId, secretPart] = parts as [string, string, string, string];
  if (prefix !== ENROLLMENT_PREFIX) return null;
  if (!ID_RE.test(orgId) || !ID_RE.test(enrollmentId) || secretPart.length < 16) return null;
  if (!ID_RE.test(secretPart)) return null;
  return { orgId, enrollmentId };
}

/**
 * Long-lived agent token handed back once, at enrollment; the server keeps only its hash.
 * Like the enrollment token it embeds the org and agent id, so the WebSocket handshake can route to a
 * tenant and authenticate under RLS without any privileged lookup path.
 */
export function newAgentToken(orgId: string, agentId: string): string {
  return `${AGENT_PREFIX}.${orgId}.${agentId}.${secret(32)}`;
}

/** The stored form of an agent token. Hashing the assembled string keeps one definition of the layout. */
export function hashAgentToken(parts: { orgId: string; agentId: string; secret: string }): string {
  return sha256(`${AGENT_PREFIX}.${parts.orgId}.${parts.agentId}.${parts.secret}`);
}

export function parseAgentToken(
  raw: string | undefined,
): { orgId: string; agentId: string; secret: string } | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [prefix, orgId, agentId, secretPart] = parts as [string, string, string, string];
  if (prefix !== AGENT_PREFIX) return null;
  if (!ID_RE.test(orgId) || !ID_RE.test(agentId) || !ID_RE.test(secretPart)) return null;
  if (secretPart.length < 24) return null;
  return { orgId, agentId, secret: secretPart };
}

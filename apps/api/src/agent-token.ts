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

/** Long-lived agent token handed back once, at enrollment; the server keeps only its hash. */
export function newAgentToken(): string {
  return `${AGENT_PREFIX}.${secret(32)}`;
}

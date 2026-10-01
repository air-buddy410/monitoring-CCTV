import { createHash, randomBytes } from "node:crypto";

export type TokenKind = "enrollment" | "agent";
const PREFIX: Record<TokenKind, string> = { enrollment: "pae_", agent: "pat_" };

/** 256 random bits, base64url, with a prefix that says what the token is for. */
export function newToken(kind: TokenKind): string {
  return PREFIX[kind] + randomBytes(32).toString("base64url");
}

/** Tokens are random, not passwords, so a fast hash is the right tool; only the hash is stored. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const SHAPE: Record<TokenKind, RegExp> = {
  enrollment: /^pae_[A-Za-z0-9_-]{43}$/,
  agent: /^pat_[A-Za-z0-9_-]{43}$/,
};

/** Pulls a well-formed token out of `Authorization: <Scheme> <token>`; null for anything else. */
export function bearerOf(
  header: string | undefined,
  scheme: "Enroll" | "Agent",
  kind: TokenKind,
): string | null {
  const m = /^(\S+) (\S+)$/.exec(header ?? "");
  if (!m || m[1] !== scheme) return null;
  return SHAPE[kind].test(m[2] as string) ? (m[2] as string) : null;
}

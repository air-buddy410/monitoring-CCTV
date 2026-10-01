import { z } from "zod";
import { validateCidrs } from "./target-policy";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
const perMin = (def: number) => z.coerce.number().int().min(1).max(100_000).default(def);

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  BASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  VAULT_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "VAULT_KEY must be 32 bytes, base64"),
  ALLOW_LOOPBACK_TARGETS: bool,
  ONVIF_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5000),
  SNAPSHOT_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(5000),
  // explicit target allow-list (CIDRs). Empty = built-in private LAN ranges only (RFC1918 + fc00::/7).
  TARGET_ALLOW_CIDRS: csv,
  // extra browser origins allowed for state-changing requests (BASE_URL's origin is always allowed)
  TRUSTED_ORIGINS: csv,
  // true only when running behind a reverse proxy you control (affects req.ip, hence rate limiting)
  TRUST_PROXY: bool,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  RATE_LIMIT_PROBE_PER_MIN: perMin(10),
  RATE_LIMIT_SNAPSHOT_PER_MIN: perMin(30),
  RATE_LIMIT_AUTH_PER_MIN: perMin(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  baseUrl: string;
  authSecret: string;
  vaultKey: string;
  allowLoopbackTargets: boolean;
  onvifTimeoutMs: number;
  snapshotTimeoutMs: number;
  logLevel: string;
  targetAllowCidrs: string[];
  trustedOrigins: string[];
  trustProxy: boolean;
  rateLimit: { windowMs: number; probe: number; snapshot: number; auth: number };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    // report variable names and reasons only, never values
    const msg = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${msg}`);
  }
  const e = r.data;
  try {
    validateCidrs(e.TARGET_ALLOW_CIDRS);
  } catch (err) {
    throw new Error(`invalid configuration: TARGET_ALLOW_CIDRS: ${(err as Error).message}`);
  }
  let extraOrigins: string[];
  try {
    extraOrigins = e.TRUSTED_ORIGINS.map((o) => new URL(o).origin);
  } catch {
    throw new Error("invalid configuration: TRUSTED_ORIGINS must be a comma-separated list of URLs");
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    baseUrl: e.BASE_URL,
    authSecret: e.AUTH_SECRET,
    vaultKey: e.VAULT_KEY,
    allowLoopbackTargets: e.ALLOW_LOOPBACK_TARGETS,
    onvifTimeoutMs: e.ONVIF_TIMEOUT_MS,
    snapshotTimeoutMs: e.SNAPSHOT_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
    targetAllowCidrs: e.TARGET_ALLOW_CIDRS,
    trustedOrigins: [
      ...new Set([new URL(e.BASE_URL).origin, ...e.TRUSTED_ORIGINS.map((o) => new URL(o).origin)]),
    ],
    trustProxy: e.TRUST_PROXY,
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      probe: e.RATE_LIMIT_PROBE_PER_MIN,
      snapshot: e.RATE_LIMIT_SNAPSHOT_PER_MIN,
      auth: e.RATE_LIMIT_AUTH_PER_MIN,
    },
  };
}

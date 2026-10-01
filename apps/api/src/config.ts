import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

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
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    // report variable names and reasons only, never values
    const msg = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${msg}`);
  }
  const e = r.data;
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
  };
}

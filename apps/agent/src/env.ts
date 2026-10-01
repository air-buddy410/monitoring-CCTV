import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const flag = z
  .string()
  .optional()
  .transform((v) => v === "true");
const url = (schemes: string[]) =>
  z.string().refine((v) => {
    try {
      return schemes.includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "must be a URL");

const Env = z.object({
  PANTAU_API_URL: url(["https:", "http:"]),
  PANTAU_WS_URL: url(["wss:", "ws:"]).optional(),
  PANTAU_AGENT_DATA_DIR: z.string().min(1).optional(),
  PANTAU_AGENT_NAME: z.string().min(1).max(120).optional(),
  PANTAU_ALLOW_LOOPBACK: flag,
  PANTAU_ALLOW_INSECURE: flag,
  PANTAU_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface AgentEnv {
  apiUrl: string;
  wsUrl?: string;
  dataDir: string;
  name: string;
  allowLoopback: boolean;
  allowInsecure: boolean;
  logLevel: string;
}

export function loadAgentEnv(env: Record<string, string | undefined> = process.env): AgentEnv {
  const r = Env.safeParse(env);
  if (!r.success) {
    // names and reasons only: a value can be a URL with credentials in it
    throw new Error(
      `invalid configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const e = r.data;
  return {
    apiUrl: e.PANTAU_API_URL,
    ...(e.PANTAU_WS_URL ? { wsUrl: e.PANTAU_WS_URL } : {}),
    dataDir: resolve(e.PANTAU_AGENT_DATA_DIR ?? "pantau-agent-data"),
    name: e.PANTAU_AGENT_NAME ?? hostname(),
    allowLoopback: e.PANTAU_ALLOW_LOOPBACK,
    allowInsecure: e.PANTAU_ALLOW_INSECURE,
    logLevel: e.PANTAU_LOG_LEVEL,
  };
}

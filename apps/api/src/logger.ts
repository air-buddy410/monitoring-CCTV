import type { FastifyBaseLogger } from "fastify";
import pino from "pino";

/** Credentials and session material are censored even if some code path logs them by mistake. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.credentials",
  "*.credentialsEnc",
  "*.username",
];

export function createLogger(level: string, stream?: NodeJS.WritableStream): FastifyBaseLogger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, stream) as FastifyBaseLogger;
}

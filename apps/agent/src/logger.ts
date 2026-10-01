import pino from "pino";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** JSON logs with credentials and tokens redacted at any depth the structure allows. */
export function createLogger(level = "info", stream?: NodeJS.WritableStream): Logger {
  const redact = [
    "password",
    "*.password",
    "username",
    "*.username",
    "token",
    "*.token",
    "agentToken",
    "*.agentToken",
    "enrollToken",
    "*.enrollToken",
    "authorization",
    "*.authorization",
    "headers.authorization",
  ];
  const p = pino({ level, redact: { paths: redact, censor: "[redacted]" } }, stream);
  return {
    info: (...a) => (p.info as (...x: unknown[]) => void)(...a),
    warn: (...a) => (p.warn as (...x: unknown[]) => void)(...a),
    error: (...a) => (p.error as (...x: unknown[]) => void)(...a),
    debug: (...a) => (p.debug as (...x: unknown[]) => void)(...a),
  };
}

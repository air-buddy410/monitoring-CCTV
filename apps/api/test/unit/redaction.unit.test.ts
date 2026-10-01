import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { REDACT_PATHS } from "../../src/logger";

describe("logging redaction + config", () => {
  it("redacts auth headers, cookies and credential fields", () => {
    for (const p of [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
    ]) {
      expect(REDACT_PATHS).toContain(p);
    }
  });
  it("requires a 32-byte vault key and a long auth secret", () => {
    const base = { DATABASE_URL: "postgres://x", BASE_URL: "http://localhost:3000" };
    expect(() => loadConfig({ ...base, VAULT_KEY: "short", AUTH_SECRET: "x".repeat(40) })).toThrow();
    expect(() =>
      loadConfig({ ...base, VAULT_KEY: Buffer.alloc(32).toString("base64"), AUTH_SECRET: "short" }),
    ).toThrow();
  });
  it("defaults to the safe settings", () => {
    const c = loadConfig({
      DATABASE_URL: "postgres://x",
      BASE_URL: "http://localhost:3000",
      VAULT_KEY: Buffer.alloc(32).toString("base64"),
      AUTH_SECRET: "x".repeat(40),
    });
    expect(c.allowLoopbackTargets).toBe(false);
    expect(c.onvifTimeoutMs).toBeLessThanOrEqual(10_000);
  });
});

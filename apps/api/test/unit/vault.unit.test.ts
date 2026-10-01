import { describe, expect, it } from "vitest";
import { createVault } from "../../src/vault";

const key = Buffer.alloc(32, 3).toString("base64");

describe("credential vault (AES-256-GCM)", () => {
  it("round-trips and never stores plaintext", () => {
    const v = createVault(key);
    const blob = v.encrypt("Dummy-Pw-1");
    expect(blob).not.toContain("Dummy-Pw-1");
    expect(v.decrypt(blob)).toBe("Dummy-Pw-1");
  });
  it("uses a fresh nonce each time", () => {
    const v = createVault(key);
    expect(v.encrypt("same")).not.toBe(v.encrypt("same"));
  });
  it("detects tampering", () => {
    const v = createVault(key);
    const buf = Buffer.from(v.encrypt("x"), "base64");
    buf[buf.length - 1] = (buf[buf.length - 1] ?? 0) ^ 1;
    expect(() => v.decrypt(buf.toString("base64"))).toThrow();
  });
  it("fails with a different key", () => {
    const blob = createVault(key).encrypt("x");
    expect(() => createVault(Buffer.alloc(32, 4).toString("base64")).decrypt(blob)).toThrow();
  });
  it("rejects keys that are not 32 bytes", () => {
    expect(() => createVault(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

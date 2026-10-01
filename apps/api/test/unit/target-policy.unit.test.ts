import { describe, expect, it } from "vitest";
import { checkTarget } from "../../src/target-policy";

describe("device target policy", () => {
  it("always blocks link-local, unspecified and multicast", () => {
    for (const h of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "fe80::1", "::"]) {
      expect(checkTarget(h, { allowLoopback: true }).allowed, h).toBe(false);
    }
  });
  it("blocks loopback unless explicitly allowed", () => {
    expect(checkTarget("127.0.0.1", { allowLoopback: false }).allowed).toBe(false);
    expect(checkTarget("::1", { allowLoopback: false }).allowed).toBe(false);
    expect(checkTarget("127.0.0.1", { allowLoopback: true }).allowed).toBe(true);
  });
  it("allows ordinary LAN addresses", () => {
    expect(checkTarget("192.168.10.20", { allowLoopback: false }).allowed).toBe(true);
    expect(checkTarget("10.1.2.3", { allowLoopback: false }).allowed).toBe(true);
  });
  it("rejects non-IP-literals (no DNS resolution => no rebinding)", () => {
    expect(checkTarget("camera.example.test", { allowLoopback: true }).allowed).toBe(false);
    expect(checkTarget("localhost", { allowLoopback: true }).allowed).toBe(false);
  });
});

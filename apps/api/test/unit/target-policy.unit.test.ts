import { describe, expect, it } from "vitest";
import { checkTarget } from "../../src/target-policy";

describe("device target policy", () => {
  it("always blocks link-local, unspecified and multicast", () => {
    for (const h of [
      "169.254.169.254",
      "169.254.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "fe80::1",
      "::",
    ]) {
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

describe("explicit target policy (allow-list)", () => {
  const lan = { allowLoopback: false };
  it("by default only private LAN ranges are allowed; public addresses are not", () => {
    for (const h of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "2001:4860:4860::8888"]) {
      expect(checkTarget(h, lan).allowed, h).toBe(false);
    }
    for (const h of ["10.0.0.1", "172.16.5.5", "172.31.255.254", "192.168.1.1", "fd12:3456::1"]) {
      expect(checkTarget(h, lan).allowed, h).toBe(true);
    }
    expect(checkTarget("172.32.0.1", lan).allowed).toBe(false);
  });
  it("an explicit lab exception (CIDR) can widen the allow-list", () => {
    const lab = { allowLoopback: false, allowCidrs: ["203.0.113.0/24"] };
    expect(checkTarget("203.0.113.9", lab).allowed).toBe(true);
    expect(checkTarget("203.0.114.9", lab).allowed).toBe(false);
    // setting an explicit list replaces the default, it does not add to it
    expect(checkTarget("192.168.1.1", lab).allowed).toBe(false);
  });
  it("the always-denied list wins over any allow-list", () => {
    const wide = { allowLoopback: true, allowCidrs: ["0.0.0.0/0", "::/0"] };
    for (const h of [
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "fe80::1",
      "fd00:ec2::254",
    ]) {
      expect(checkTarget(h, wide).allowed, h).toBe(false);
    }
  });
  it("IPv4-mapped IPv6 cannot smuggle denied targets", () => {
    expect(checkTarget("::ffff:169.254.169.254", { allowLoopback: true }).allowed).toBe(false);
    expect(checkTarget("::ffff:127.0.0.1", lan).allowed).toBe(false);
    expect(checkTarget("::ffff:192.168.1.1", lan).allowed).toBe(true);
  });
  it("non-canonical IP spellings are not IP literals and are refused", () => {
    for (const h of [
      "0177.0.0.1",
      "2130706433",
      "0x7f.0.0.1",
      "127.1",
      "192.168.1",
      "1.2.3.4.5",
      " 10.0.0.1",
      "",
    ]) {
      expect(checkTarget(h, { allowLoopback: true }).allowed, JSON.stringify(h)).toBe(false);
    }
  });
});

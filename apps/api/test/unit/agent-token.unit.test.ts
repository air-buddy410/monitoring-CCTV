import { describe, expect, it } from "vitest";
import {
  newAgentToken,
  newEnrollmentToken,
  parseAgentToken,
  parseEnrollmentToken,
  sha256,
} from "../../src/agent-token";

describe("agent enrollment tokens", () => {
  it("round-trips org and enrollment ids through the token", () => {
    const token = newEnrollmentToken("org_abc123", "enr_deadbeef");
    const parsed = parseEnrollmentToken(token);
    expect(parsed).toEqual({ orgId: "org_abc123", enrollmentId: "enr_deadbeef" });
  });

  it("rejects malformed tokens instead of guessing", () => {
    for (const bad of [
      "",
      "enr",
      "enr.only.two",
      "enr.a.b.c.d",
      "nope.org.enr.abc",
      "enr..enr_x.secret",
      "enr.org_x..secret",
      "enr.org x.enr_x.secret",
    ]) {
      expect(parseEnrollmentToken(bad), bad).toBeNull();
    }
  });

  it("generates high-entropy, distinct secrets", () => {
    const a = newEnrollmentToken("org_a", "enr_a");
    const b = newEnrollmentToken("org_a", "enr_a");
    expect(a).not.toBe(b);
    expect(a.split(".")[3]?.length ?? 0).toBeGreaterThanOrEqual(24);
  });

  it("agent tokens carry their org and agent id and stay unique", () => {
    const t = newAgentToken("org_a", "agt_a");
    expect(t.startsWith("agt.")).toBe(true);
    expect(t).not.toBe(newAgentToken("org_a", "agt_a"));
    expect(parseAgentToken(t)).toMatchObject({ orgId: "org_a", agentId: "agt_a" });
  });

  it("sha256 is stable hex and never returns the input", () => {
    const h = sha256("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("hello")).toBe(h);
    expect(h).not.toContain("hello");
  });
});

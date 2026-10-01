import {
  AGENT_INBOUND_TYPES,
  AGENT_OUTBOUND_TYPES,
  AGENT_TIMEOUTS_MS,
  AgentEnvelope,
  AgentHello,
  AgentInventorySync,
  AgentPtzCommand,
  AgentStatusReport,
} from "@pantau/contracts";
import { describe, expect, it } from "vitest";
import { AgentHub, backoffDelayMs } from "../../src/agent-hub";
import { newAgentToken, parseAgentToken } from "../../src/agent-token";

describe("agent protocol", () => {
  it("has no type that is both inbound and outbound by accident, except the shared ice channel", () => {
    const both = AGENT_INBOUND_TYPES.filter((t) => (AGENT_OUTBOUND_TYPES as readonly string[]).includes(t));
    expect(both).toEqual(["ice"]);
  });

  it("envelope requires id, type and ts and rejects a missing id", () => {
    expect(AgentEnvelope.safeParse({ id: "m1", type: "hello", ts: "1", payload: {} }).success).toBe(true);
    expect(AgentEnvelope.safeParse({ type: "hello", ts: "1", payload: {} }).success).toBe(false);
  });

  it("hello is tolerant of an old agent that sends no go2rtc version", () => {
    const r = AgentHello.safeParse({ version: "0.1.0" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.go2rtcVersion).toBeUndefined();
  });

  it("inventory rejects credentials smuggled into a camera (metadata only)", () => {
    const base = {
      key: "10.0.0.5:80",
      name: "NVR",
      kind: "nvr",
      host: "10.0.0.5",
      port: 80,
      adapterId: "onvif-generic",
    };
    const withSecret = AgentInventorySync.safeParse({
      devices: [
        {
          ...base,
          cameras: [{ channel: "1", name: "Cam 1", password: "hunter2", username: "admin" }],
        },
      ],
    });
    expect(withSecret.success).toBe(false);
    const clean = AgentInventorySync.safeParse({
      devices: [{ ...base, cameras: [{ channel: "1", name: "Cam 1" }] }],
    });
    expect(clean.success).toBe(true);
  });

  it("status rejects an out-of-range percentage instead of clamping it silently", () => {
    expect(AgentStatusReport.safeParse({ cpuPct: 101 }).success).toBe(false);
    expect(AgentStatusReport.safeParse({ cpuPct: 42.5 }).success).toBe(true);
  });

  it("ptz accepts the eight actions and refuses an unknown one", () => {
    expect(AgentPtzCommand.safeParse({ cameraId: "cam_1", action: "left" }).success).toBe(true);
    expect(AgentPtzCommand.safeParse({ cameraId: "cam_1", action: "self-destruct" }).success).toBe(false);
  });

  it("declares a timeout for every request kind (PRD section 9.2)", () => {
    expect(AGENT_TIMEOUTS_MS.ptz).toBe(3000);
    expect(AGENT_TIMEOUTS_MS.snapshot).toBe(5000);
    expect(AGENT_TIMEOUTS_MS.recordings).toBe(15_000);
  });
});

describe("reconnect backoff", () => {
  it("doubles the ceiling per attempt from 1 s and never exceeds 60 s", () => {
    // delay is drawn from [ceiling/2, ceiling]; the ceiling doubles per attempt (PRD section 9.2)
    for (const [attempt, ceiling] of [
      [0, 1000],
      [1, 2000],
      [5, 32_000],
    ] as const) {
      expect(backoffDelayMs(attempt, () => 0)).toBe(ceiling / 2);
      expect(backoffDelayMs(attempt, () => 1)).toBe(ceiling);
    }
    for (let i = 0; i < 40; i++) {
      expect(backoffDelayMs(i, () => 1)).toBeLessThanOrEqual(60_000);
      expect(backoffDelayMs(i, () => 0)).toBeGreaterThanOrEqual(500);
    }
  });

  it("applies jitter so a fleet does not reconnect in lockstep", () => {
    const lo = backoffDelayMs(3, () => 0);
    const hi = backoffDelayMs(3, () => 1);
    expect(lo).toBeLessThan(hi);
    expect(lo).toBeGreaterThan(0);
  });
});

describe("agent token parsing", () => {
  it("round-trips org and agent id and rejects anything malformed", () => {
    const token = newAgentToken("org_abc", "agt_deadbeef");
    expect(parseAgentToken(token)).toMatchObject({ orgId: "org_abc", agentId: "agt_deadbeef" });
    expect(parseAgentToken(token)?.secret).toBe(token.split(".")[3]);
    for (const bad of [
      "",
      "agt",
      "agt.only.three",
      "agt.org.agt_x.short",
      "enr.org.x.yyyyyyyyyyyyyyyyyyyyyyyy",
      "Agent agt.org.agt_x.yyyyyyyyyyyyyyyyyyyyyyyy",
    ]) {
      expect(parseAgentToken(bad), bad).toBeNull();
    }
  });
});

describe("hub registry", () => {
  it("keeps at most one live connection per agent and closes the older one", async () => {
    const hub = new AgentHub();
    const closed: string[] = [];
    const make = (agentId: string, connId: string) => ({
      agentId,
      orgId: "org_1",
      siteId: "site_1",
      send: () => true,
      close: () => closed.push(connId),
    });
    const first = make("agt_1", "first");
    const second = make("agt_1", "second");
    hub.attach(first);
    expect(hub.size()).toBe(1);
    hub.attach(second);
    expect(hub.size()).toBe(1);
    expect(closed).toEqual(["first"]);
    expect(hub.get("agt_1")).toBe(second);
    hub.detach(second);
    expect(hub.size()).toBe(0);
    // detaching a stale connection must not evict the current one
    hub.attach(first);
    hub.detach(second);
    expect(hub.get("agt_1")).toBe(first);
  });

  it("refuses to deliver a request to an agent that is not connected", async () => {
    const hub = new AgentHub();
    await expect(hub.request("agt_missing", "ptz", {})).rejects.toThrow(/not connected/i);
  });

  it("times a request out instead of hanging when the agent never answers", async () => {
    const hub = new AgentHub();
    hub.attach({
      agentId: "agt_1",
      orgId: "org_1",
      siteId: "site_1",
      send: () => true,
      close: () => undefined,
    });
    const started = Date.now();
    await expect(hub.request("agt_1", "ptz", {}, 40)).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

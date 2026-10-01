import { StatusReport } from "@pantau/contracts";
import { describe, expect, it } from "vitest";
import { collectStatus, cpuPercentBetween } from "../src/status";

const devices = [
  { deviceKey: "dev-a", host: "10.0.0.5", port: 80, cameras: [{ channel: "1" }, { channel: "2" }] },
  { deviceKey: "dev-b", host: "10.0.0.6", port: 80, cameras: [{ channel: "1" }] },
];

describe("status report", () => {
  it("marks every camera of a reachable device online and of an unreachable one offline", async () => {
    const out = await collectStatus({
      devices,
      reachable: async (h) => h === "10.0.0.5",
      cpu: () => 10,
      mem: () => ({ total: 1000, free: 250 }),
      disk: () => ({ total: 100, free: 40 }),
      uptimeSec: () => 99,
    });
    expect(StatusReport.safeParse(out).success).toBe(true);
    expect(out.cameras).toEqual([
      { deviceKey: "dev-a", channel: "1", online: true },
      { deviceKey: "dev-a", channel: "2", online: true },
      { deviceKey: "dev-b", channel: "1", online: false },
    ]);
    expect(out).toMatchObject({ cpuPercent: 10, memUsedPercent: 75, diskUsedPercent: 60, uptimeSec: 99 });
  });

  it("a probe that throws counts as offline and never breaks the report", async () => {
    const out = await collectStatus({
      devices,
      reachable: async () => {
        throw new Error("network down");
      },
      cpu: () => 0,
      mem: () => ({ total: 1, free: 1 }),
      disk: () => ({ total: 1, free: 1 }),
      uptimeSec: () => 1,
    });
    expect(out.cameras.every((c) => !c.online)).toBe(true);
  });

  it("checks reachability concurrently, not one device after another", async () => {
    const started: number[] = [];
    await collectStatus({
      devices: Array.from({ length: 5 }, (_, i) => ({
        deviceKey: `d${i}`,
        host: `10.0.0.${i + 1}`,
        port: 80,
        cameras: [{ channel: "1" }],
      })),
      reachable: async () => {
        started.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return true;
      },
      cpu: () => 0,
      mem: () => ({ total: 1, free: 1 }),
      disk: () => ({ total: 1, free: 1 }),
      uptimeSec: () => 1,
    });
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(40);
  });

  it("percentages are clamped to 0..100 and an empty disk or memory reading is not a division by zero", async () => {
    const out = await collectStatus({
      devices: [],
      reachable: async () => true,
      cpu: () => 250,
      mem: () => ({ total: 0, free: 0 }),
      disk: () => ({ total: 0, free: 0 }),
      uptimeSec: () => 1,
    });
    expect(out.cpuPercent).toBe(100);
    expect(out.memUsedPercent).toBe(0);
    expect(out.diskUsedPercent).toBe(0);
    expect(StatusReport.safeParse(out).success).toBe(true);
  });

  it("cpu percent is the busy share between two samples", () => {
    const a = [{ times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } }];
    const b = [{ times: { user: 200, nice: 0, sys: 150, idle: 850, irq: 0 } }];
    expect(cpuPercentBetween(a, b)).toBeCloseTo(75, 5);
    expect(cpuPercentBetween(a, a)).toBe(0);
  });
});

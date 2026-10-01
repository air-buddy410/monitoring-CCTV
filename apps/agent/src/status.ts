import { statfsSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import type { StatusReport } from "@pantau/contracts";

export interface StatusInput {
  devices: { deviceKey: string; host: string; port: number; cameras: { channel: string }[] }[];
  reachable: (host: string, port: number) => Promise<boolean>;
  cpu: () => number;
  mem: () => { total: number; free: number };
  disk: () => { total: number; free: number };
  uptimeSec: () => number;
}

const pct = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));
const used = ({ total, free }: { total: number; free: number }) =>
  total > 0 ? pct(((total - free) / total) * 100) : 0;

/** One status frame: camera reachability (checked in parallel) plus host load. Never throws for a bad probe. */
export async function collectStatus(i: StatusInput): Promise<StatusReport> {
  const up = new Map<string, boolean>();
  await Promise.all(
    i.devices.map(async (d) => {
      try {
        up.set(d.deviceKey, await i.reachable(d.host, d.port));
      } catch {
        up.set(d.deviceKey, false);
      }
    }),
  );
  return {
    cameras: i.devices.flatMap((d) =>
      d.cameras.map((c) => ({
        deviceKey: d.deviceKey,
        channel: c.channel,
        online: up.get(d.deviceKey) === true,
      })),
    ),
    cpuPercent: pct(i.cpu()),
    memUsedPercent: used(i.mem()),
    diskUsedPercent: used(i.disk()),
    uptimeSec: Math.max(0, Math.floor(i.uptimeSec())),
  };
}

type CpuSample = { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[];

/** Busy share of all cores between two os.cpus() samples. */
export function cpuPercentBetween(a: CpuSample, b: CpuSample): number {
  const sum = (s: CpuSample) =>
    s.reduce((n, c) => n + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0);
  const idle = (s: CpuSample) => s.reduce((n, c) => n + c.times.idle, 0);
  const total = sum(b) - sum(a);
  if (total <= 0) return 0;
  return pct((1 - (idle(b) - idle(a)) / total) * 100);
}

/** TCP connect to the device's ONVIF port: a LAN-only liveness check that needs no credentials. */
export function tcpReachable(timeoutMs = 2000) {
  return (host: string, port: number) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
}

/** Host probes backed by the real operating system. */
export function systemProbes(dataDir: string) {
  let prev: CpuSample = os.cpus();
  return {
    cpu: () => {
      const now = os.cpus();
      const v = cpuPercentBetween(prev, now);
      prev = now;
      return v;
    },
    mem: () => ({ total: os.totalmem(), free: os.freemem() }),
    disk: () => {
      const s = statfsSync(dataDir);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    },
    uptimeSec: () => os.uptime(),
  };
}

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InventorySync, type ProbeResult } from "@pantau/contracts";
import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/devices";
import { FileVault } from "../src/vault";

const SENTINEL_USER = "dummy-admin";
const SENTINEL_PASS = "Dummy-Sentinel-Pw-7391!";
const probed: ProbeResult = {
  brand: "mockvendor",
  manufacturer: "MockVendor",
  model: "MV-NVR-2",
  firmware: "9.9.9",
  channels: [
    { channel: "1", name: "Pintu", hasPtz: false, mainCodec: "H264", subCodec: "H264" },
    { channel: "2", name: "Gudang", hasPtz: true, mainCodec: "H265", subCodec: null },
  ],
  capabilities: {
    live: "ya",
    snapshot: "ya",
    ptz: "ya",
    "ptz.preset": "belum-diuji",
    "events.motion": "belum-diuji",
    "playback.search": "tidak",
    "playback.stream": "tidak",
    health: "belum-diuji",
  },
};
const make = (over: { probe?: () => Promise<ProbeResult>; allowLoopback?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "pantau-dev-"));
  const calls: { host: string; port: number; username: string; password: string }[] = [];
  const reg = new DeviceRegistry({
    dir,
    vault: FileVault.open(join(dir, "vault")),
    allowLoopback: over.allowLoopback ?? false,
    timeoutMs: 1000,
    probe: async (conn) => {
      calls.push({ host: conn.host, port: conn.port, username: conn.username, password: conn.password });
      return over.probe ? over.probe() : probed;
    },
  });
  return { dir, reg, calls };
};
const input = (over: Record<string, unknown> = {}) => ({
  name: "NVR Lab",
  host: "192.168.1.20",
  port: 80,
  username: SENTINEL_USER,
  password: SENTINEL_PASS,
  ...over,
});

describe("local device registry (metadata on disk, credentials only in the vault)", () => {
  it("probes the device, stores credentials in the vault and returns metadata only", async () => {
    const { reg, dir, calls } = make();
    const d = await reg.add(input());
    expect(calls).toEqual([
      { host: "192.168.1.20", port: 80, username: SENTINEL_USER, password: SENTINEL_PASS },
    ]);
    expect(d).toMatchObject({
      name: "NVR Lab",
      host: "192.168.1.20",
      port: 80,
      kind: "nvr",
      brand: "mockvendor",
      model: "MV-NVR-2",
    });
    expect(JSON.stringify(d)).not.toContain(SENTINEL_PASS);
    expect(JSON.stringify(d)).not.toContain(SENTINEL_USER);
    expect(d.deviceKey).toMatch(/^dev-[a-z0-9]{8,}$/);
    expect(reg.list()).toHaveLength(1);
    expect(reg.credentialsFor(d.deviceKey)).toEqual({ username: SENTINEL_USER, password: SENTINEL_PASS });
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toContain(SENTINEL_PASS);
      expect(text, f).not.toContain(SENTINEL_USER);
    }
  });

  it("builds an inventory the server accepts, with no credentials in it", async () => {
    const { reg } = make();
    await reg.add(input());
    await reg.add(input({ name: "IPC", host: "192.168.1.21" }));
    const inv = reg.toInventory();
    expect(InventorySync.safeParse(inv).success).toBe(true);
    expect(inv.devices).toHaveLength(2);
    expect(JSON.stringify(inv)).not.toContain(SENTINEL_PASS);
    expect(JSON.stringify(inv)).not.toContain(SENTINEL_USER);
    expect(inv.devices[0]?.cameras.map((c) => c.channel)).toEqual(["1", "2"]);
  });

  it("survives a restart: devices and credentials load again", async () => {
    const { reg, dir } = make();
    const d = await reg.add(input());
    const again = new DeviceRegistry({
      dir,
      vault: FileVault.open(join(dir, "vault")),
      allowLoopback: false,
      timeoutMs: 1000,
      probe: async () => probed,
    });
    expect(again.list().map((x) => x.deviceKey)).toEqual([d.deviceKey]);
    expect(again.credentialsFor(d.deviceKey)?.password).toBe(SENTINEL_PASS);
  });

  it("applies the same target policy as the API: public IPs, names, link-local and metadata addresses are refused before any connection", async () => {
    const { reg, calls } = make();
    for (const host of [
      "8.8.8.8",
      "cam.example.test",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "127.0.0.1",
      "::1",
      "0177.0.0.1",
      "10.0.0.1/8",
    ]) {
      await expect(reg.add(input({ host })), host).rejects.toMatchObject({ code: "target_not_allowed" });
    }
    expect(calls).toHaveLength(0);
    expect(reg.list()).toHaveLength(0);
  });

  it("loopback is allowed only with the explicit lab flag", async () => {
    const { reg } = make({ allowLoopback: true });
    await expect(reg.add(input({ host: "127.0.0.1", port: 8080 }))).resolves.toBeTruthy();
  });

  it("a failed probe stores nothing: no device, no vault entry", async () => {
    const { reg, dir } = make({
      probe: async () => Promise.reject(Object.assign(new Error("boom"), { code: "device_auth_failed" })),
    });
    await expect(reg.add(input())).rejects.toMatchObject({ code: "device_auth_failed" });
    expect(reg.list()).toHaveLength(0);
    expect(FileVault.open(join(dir, "vault")).keys()).toEqual([]);
  });

  it("a device with no channels is refused", async () => {
    const { reg } = make({ probe: async () => ({ ...probed, channels: [] }) });
    await expect(reg.add(input())).rejects.toMatchObject({ code: "device_no_channels" });
    expect(reg.list()).toHaveLength(0);
  });

  it("the same address and port cannot be added twice", async () => {
    const { reg } = make();
    await reg.add(input());
    await expect(reg.add(input({ name: "Lagi" }))).rejects.toMatchObject({ code: "device_exists" });
    expect(reg.list()).toHaveLength(1);
  });

  it("removing a device also removes its credentials", async () => {
    const { reg, dir } = make();
    const d = await reg.add(input());
    reg.remove(d.deviceKey);
    expect(reg.list()).toHaveLength(0);
    expect(reg.credentialsFor(d.deviceKey)).toBeNull();
    expect(FileVault.open(join(dir, "vault")).keys()).toEqual([]);
  });

  it("error messages and codes never carry the password", async () => {
    const { reg } = make({
      probe: async () => Promise.reject(new Error(`login failed for ${SENTINEL_USER}:${SENTINEL_PASS}`)),
    });
    try {
      await reg.add(input());
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SENTINEL_PASS);
      expect(JSON.stringify(e)).not.toContain(SENTINEL_PASS);
    }
  });
});

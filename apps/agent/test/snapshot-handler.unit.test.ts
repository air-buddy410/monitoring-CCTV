import { AdapterError } from "@pantau/adapters";
import { describe, expect, it } from "vitest";
import { makeSnapshotHandler } from "../src/snapshot-handler";

const SENTINEL = "Dummy-Sentinel-Pw-7391!";
const dev = { deviceKey: "dev-1", host: "192.168.1.20", port: 80, cameras: [{ channel: "1" }] };
const registry = (devices = [dev]) => ({
  list: () => devices,
  credentialsFor: (k: string) => (k === "dev-1" ? { username: "dummy-admin", password: SENTINEL } : null),
});
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);

describe("snapshot handler on the agent", () => {
  it("takes the snapshot with the vault credentials and returns it base64 encoded", async () => {
    const calls: { host: string; port: number; username: string; password: string; channel: string }[] = [];
    const h = makeSnapshotHandler({
      registry: registry(),
      timeoutMs: 1234,
      snapshot: async (conn, channel) => {
        calls.push({
          host: conn.host,
          port: conn.port,
          username: conn.username,
          password: conn.password,
          channel,
        });
        expect(conn.timeoutMs).toBe(1234);
        return jpeg;
      },
    });
    const out = await h({ deviceKey: "dev-1", channel: "1" });
    expect(out).toEqual({ ok: true, jpegBase64: jpeg.toString("base64") });
    expect(calls).toEqual([
      { host: "192.168.1.20", port: 80, username: "dummy-admin", password: SENTINEL, channel: "1" },
    ]);
  });

  it("an unknown device or channel is refused without contacting anything", async () => {
    let called = 0;
    const h = makeSnapshotHandler({
      registry: registry(),
      timeoutMs: 1000,
      snapshot: async () => (called++, jpeg),
    });
    expect(await h({ deviceKey: "nope", channel: "1" })).toEqual({ ok: false, code: "device_not_found" });
    expect(await h({ deviceKey: "dev-1", channel: "9" })).toEqual({
      ok: false,
      code: "snapshot_channel_not_found",
    });
    expect(called).toBe(0);
  });

  it("a device without stored credentials is refused", async () => {
    const h = makeSnapshotHandler({
      registry: { list: () => [{ ...dev, deviceKey: "dev-2" }], credentialsFor: () => null },
      timeoutMs: 1000,
      snapshot: async () => jpeg,
    });
    expect(await h({ deviceKey: "dev-2", channel: "1" })).toEqual({ ok: false, code: "device_auth_failed" });
  });

  it("adapter errors keep their stable code and never their message", async () => {
    const h = makeSnapshotHandler({
      registry: registry(),
      timeoutMs: 1000,
      snapshot: async () => {
        throw new AdapterError("device_timeout");
      },
    });
    expect(await h({ deviceKey: "dev-1", channel: "1" })).toEqual({ ok: false, code: "device_timeout" });
    const h2 = makeSnapshotHandler({
      registry: registry(),
      timeoutMs: 1000,
      snapshot: async () => {
        throw new Error(`login failed for dummy-admin:${SENTINEL}`);
      },
    });
    const out = await h2({ deviceKey: "dev-1", channel: "1" });
    expect(out).toEqual({ ok: false, code: "snapshot_failed" });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it("an image over 1 MiB is not sent", async () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 1);
    const h = makeSnapshotHandler({ registry: registry(), timeoutMs: 1000, snapshot: async () => big });
    expect(await h({ deviceKey: "dev-1", channel: "1" })).toEqual({ ok: false, code: "snapshot_too_large" });
  });

  it("a malformed request is refused as invalid, not thrown", async () => {
    const h = makeSnapshotHandler({ registry: registry(), timeoutMs: 1000, snapshot: async () => jpeg });
    expect(await h({ nope: 1 })).toEqual({ ok: false, code: "invalid_request" });
  });
});

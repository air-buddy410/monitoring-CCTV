import { describe, expect, it } from "vitest";
import {
  AgentInbound,
  AgentOutbound,
  Envelope,
  FORBIDDEN_PAYLOAD_KEYS,
  InventorySync,
  parseEnvelope,
} from "../src/agent";

const base = { id: "m-1", ts: "2026-10-01T00:00:00.000Z" };
const device = {
  deviceKey: "dev-1",
  name: "NVR Lab",
  kind: "nvr" as const,
  brand: "mockvendor",
  model: "MV-NVR-2",
  firmware: "9.9.9",
  adapterId: "onvif-generic" as const,
  host: "192.168.1.20",
  port: 80,
  capabilities: { live: "ya", snapshot: "ya" },
  cameras: [{ channel: "1", name: "Pintu", hasPtz: false, mainCodec: "H264", subCodec: null }],
};

describe("agent envelope", () => {
  it("accepts {id, type, ts, payload} and nothing else", () => {
    const ok = {
      ...base,
      type: "hello",
      payload: { agentVersion: "0.1.0", go2rtcVersion: null, hostname: "mini-pc" },
    };
    expect(Envelope.safeParse(ok).success).toBe(true);
    expect(Envelope.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    for (const missing of ["id", "type", "ts", "payload"]) {
      const copy: Record<string, unknown> = { ...ok };
      delete copy[missing];
      expect(Envelope.safeParse(copy).success, missing).toBe(false);
    }
    expect(Envelope.safeParse({ ...ok, ts: "yesterday" }).success).toBe(false);
    expect(Envelope.safeParse({ ...ok, id: "" }).success).toBe(false);
    expect(Envelope.safeParse({ ...ok, id: "x".repeat(65) }).success).toBe(false);
  });

  it("parseEnvelope refuses non-JSON, non-objects and oversized frames without throwing", () => {
    expect(parseEnvelope("not json", 1000).ok).toBe(false);
    expect(parseEnvelope("[]", 1000).ok).toBe(false);
    expect(parseEnvelope("null", 1000).ok).toBe(false);
    expect(parseEnvelope(JSON.stringify({ ...base, type: "hello", payload: {} }), 10).ok).toBe(false);
    const good = parseEnvelope(JSON.stringify({ ...base, type: "x", payload: {} }), 1000);
    expect(good.ok).toBe(true);
  });
});

describe("agent to api messages", () => {
  it("hello, status and inventory.sync validate", () => {
    expect(
      AgentInbound.safeParse({
        ...base,
        type: "hello",
        payload: { agentVersion: "0.1.0", go2rtcVersion: "1.9.9", hostname: "h" },
      }).success,
    ).toBe(true);
    expect(
      AgentInbound.safeParse({
        ...base,
        type: "status",
        payload: {
          cameras: [{ deviceKey: "dev-1", channel: "1", online: true }],
          cpuPercent: 12.5,
          memUsedPercent: 40,
          diskUsedPercent: 70,
          uptimeSec: 100,
        },
      }).success,
    ).toBe(true);
    expect(
      AgentInbound.safeParse({ ...base, type: "inventory.sync", payload: { devices: [device] } }).success,
    ).toBe(true);
  });

  it("status numbers must be percentages", () => {
    const bad = { cameras: [], cpuPercent: 101, memUsedPercent: 1, diskUsedPercent: 1 };
    expect(AgentInbound.safeParse({ ...base, type: "status", payload: bad }).success).toBe(false);
    expect(
      AgentInbound.safeParse({ ...base, type: "status", payload: { ...bad, cpuPercent: -1 } }).success,
    ).toBe(false);
  });

  it("inventory.sync is metadata only: credentials, URIs and unknown fields are rejected anywhere", () => {
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      expect(InventorySync.safeParse({ devices: [{ ...device, [key]: "x" }] }).success, `device.${key}`).toBe(
        false,
      );
      const cam = { ...(device.cameras[0] as object), [key]: "x" };
      expect(
        InventorySync.safeParse({ devices: [{ ...device, cameras: [cam] }] }).success,
        `camera.${key}`,
      ).toBe(false);
      expect(InventorySync.safeParse({ devices: [device], [key]: "x" }).success, `root.${key}`).toBe(false);
    }
    expect(
      InventorySync.safeParse({ devices: [{ ...device, rtspUri: "rtsp://u:p@10.0.0.1/s" }] }).success,
    ).toBe(false);
  });

  it("limits sizes: devices, cameras per device, and host must be a literal IP", () => {
    expect(
      InventorySync.safeParse({
        devices: Array.from({ length: 65 }, (_, i) => ({ ...device, deviceKey: `d${i}` })),
      }).success,
    ).toBe(false);
    const manyCams = Array.from({ length: 129 }, (_, i) => ({
      ...(device.cameras[0] as object),
      channel: String(i),
    }));
    expect(InventorySync.safeParse({ devices: [{ ...device, cameras: manyCams }] }).success).toBe(false);
    expect(InventorySync.safeParse({ devices: [{ ...device, host: "cam.example.test" }] }).success).toBe(
      false,
    );
  });

  it("duplicate device keys or channels in one sync are rejected", () => {
    expect(InventorySync.safeParse({ devices: [device, device] }).success).toBe(false);
    const cam = device.cameras[0] as object;
    expect(InventorySync.safeParse({ devices: [{ ...device, cameras: [cam, cam] }] }).success).toBe(false);
  });

  it("event.motion carries a thumbnail of at most 20 KB", () => {
    const ok = {
      deviceKey: "dev-1",
      channel: "1",
      at: base.ts,
      thumbnailBase64: Buffer.alloc(20 * 1024).toString("base64"),
    };
    expect(AgentInbound.safeParse({ ...base, type: "event.motion", payload: ok }).success).toBe(true);
    const big = { ...ok, thumbnailBase64: Buffer.alloc(20 * 1024 + 1).toString("base64") };
    expect(AgentInbound.safeParse({ ...base, type: "event.motion", payload: big }).success).toBe(false);
  });

  it("unknown message types are rejected", () => {
    expect(AgentInbound.safeParse({ ...base, type: "shell.exec", payload: { cmd: "id" } }).success).toBe(
      false,
    );
  });
});

describe("api to agent messages", () => {
  it("ack and error carry the id of the request they answer", () => {
    expect(AgentOutbound.safeParse({ ...base, type: "ack", payload: {} }).success).toBe(true);
    expect(
      AgentOutbound.safeParse({
        ...base,
        type: "error",
        payload: { code: "invalid_payload", message: "bad" },
      }).success,
    ).toBe(true);
  });

  it("ptz.command and snapshot.request are the only commands in M2 and are typed", () => {
    expect(
      AgentOutbound.safeParse({
        ...base,
        type: "ptz.command",
        payload: { deviceKey: "d", channel: "1", action: "move", x: 0.5, y: -0.5, z: 0 },
      }).success,
    ).toBe(true);
    expect(
      AgentOutbound.safeParse({
        ...base,
        type: "ptz.command",
        payload: { deviceKey: "d", channel: "1", action: "move", x: 2, y: 0, z: 0 },
      }).success,
    ).toBe(false);
    expect(
      AgentOutbound.safeParse({
        ...base,
        type: "ptz.command",
        payload: { deviceKey: "d", channel: "1", action: "reboot" },
      }).success,
    ).toBe(false);
    expect(
      AgentOutbound.safeParse({
        ...base,
        type: "snapshot.request",
        payload: { deviceKey: "d", channel: "1" },
      }).success,
    ).toBe(true);
  });
});

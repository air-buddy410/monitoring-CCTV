import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  createSite,
  createTenant,
  createTestEnv,
  DEVICE_PASSWORD,
  type Tenant,
  type TestEnv,
} from "../helpers";

describe("MVP-0 flow: add device -> probe -> cameras -> snapshot (against mock ONVIF)", () => {
  let env: TestEnv;
  let a: Tenant;
  let siteId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    a = await createTenant(env, "flow-a");
    siteId = (await createSite(env, a)).id;
  });
  afterAll(async () => env.close());

  it("adds a mock device, exposes brand/model/firmware, capabilities and cameras", async () => {
    const mock = await env.startMock({
      manufacturer: "MockVendor",
      model: "MV-NVR-2",
      firmware: "9.9.9-mock",
      channels: 2,
      ptzChannels: [0],
    });
    const res = await addDevice(env, a, siteId, mock);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      device: {
        id: string;
        brand: string;
        model: string;
        firmware: string;
        adapterId: string;
        kind: string;
        capabilities: Record<string, string>;
      };
      cameras: { id: string; channel: string; hasPtz: boolean; status: string; mainCodec: string | null }[];
    };
    expect(body.device.id).toMatch(/^dev_/);
    expect(body.device.brand).toBe("mockvendor");
    expect(body.device.model).toBe("MV-NVR-2");
    expect(body.device.firmware).toBe("9.9.9-mock");
    expect(body.device.adapterId).toBe("onvif-generic");
    expect(body.device.kind).toBe("nvr");
    expect(body.device.capabilities.snapshot).toBe("ya");
    expect(body.device.capabilities.live).toBe("ya");
    expect(body.device.capabilities.ptz).toBe("ya");
    // honest: things we did not test are not claimed
    expect(body.device.capabilities["playback.stream"]).not.toBe("ya");
    expect(body.device.capabilities.health).not.toBe("ya");
    expect(body.cameras).toHaveLength(2);
    expect(body.cameras.filter((c) => c.hasPtz)).toHaveLength(1);
    expect(body.cameras[0]?.mainCodec).toBe("H264");

    const detail = await env.built.app.inject({
      method: "GET",
      url: `/v1/devices/${body.device.id}`,
      headers: { cookie: a.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { cameras: unknown[] }).cameras).toHaveLength(2);

    const cams = await env.built.app.inject({
      method: "GET",
      url: `/v1/cameras?siteId=${siteId}`,
      headers: { cookie: a.cookie },
    });
    expect((cams.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it("takes a JPEG snapshot from the mock camera", async () => {
    const mock = await env.startMock({ channels: 1 });
    const add = await addDevice(env, a, siteId, mock);
    const { cameras } = add.json() as { cameras: { id: string }[] };
    const res = await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    const bytes = res.rawPayload;
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.subarray(-2).toString("hex")).toBe("ffd9");
    expect(mock.snapshotRequestCount()).toBeGreaterThanOrEqual(1);
  });

  it("rejects wrong device credentials with a clean error and creates nothing", async () => {
    const mock = await env.startMock();
    const before = (
      (
        await env.built.app.inject({ method: "GET", url: "/v1/devices", headers: { cookie: a.cookie } })
      ).json() as {
        items: unknown[];
      }
    ).items.length;
    const res = await addDevice(env, a, siteId, mock, { password: "Wrong-Dummy-Pw-0000!" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("device_auth_failed");
    const after = (
      (
        await env.built.app.inject({ method: "GET", url: "/v1/devices", headers: { cookie: a.cookie } })
      ).json() as {
        items: unknown[];
      }
    ).items.length;
    expect(after).toBe(before);
    expect(res.body).not.toContain(DEVICE_PASSWORD);
  });

  it("returns 504-style timeout error when the device hangs, within the configured deadline", async () => {
    const mock = await env.startMock({ hangOperations: ["GetDeviceInformation"] });
    const t0 = Date.now();
    const res = await addDevice(env, a, siteId, mock);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect([502, 504]).toContain(res.statusCode);
    expect((res.json() as { code: string }).code).toBe("device_timeout");
  });

  it("refuses snapshot URIs that point at another host (SSRF guard)", async () => {
    const mock = await env.startMock({ snapshotUriHost: "10.255.255.1" });
    const add = await addDevice(env, a, siteId, mock);
    expect(add.statusCode).toBe(201);
    const { cameras } = add.json() as { cameras: { id: string }[] };
    const res = await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe("snapshot_uri_host_mismatch");
  });

  it("refuses non-JPEG snapshot payloads", async () => {
    const mock = await env.startMock({ snapshotBody: Buffer.from("<html>not a jpeg</html>") });
    const add = await addDevice(env, a, siteId, mock);
    const { cameras } = add.json() as { cameras: { id: string }[] };
    const res = await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe("snapshot_invalid_image");
  });

  it("rejects link-local / metadata targets always and loopback when not allowed", async () => {
    const meta = await env.built.app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { cookie: a.cookie },
      payload: { siteId, name: "x", host: "169.254.169.254", port: 80, username: "u", password: "p" },
    });
    expect(meta.statusCode).toBe(422);
    expect((meta.json() as { code: string }).code).toBe("target_not_allowed");

    const strict = await createTestEnv({ ALLOW_LOOPBACK_TARGETS: "false" });
    try {
      const t = await createTenant(strict, "strict");
      const s = await createSite(strict, t);
      const mock = await strict.startMock();
      const res = await addDevice(strict, t, s.id, mock);
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe("target_not_allowed");
    } finally {
      await strict.close();
    }
  });
});

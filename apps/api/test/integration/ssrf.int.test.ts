import { type Decoy, startDecoy } from "@pantau/mock-onvif";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDevice, createSite, createTenant, createTestEnv, type Tenant, type TestEnv } from "../helpers";

describe("SSRF: nothing the device says can redirect us elsewhere", () => {
  let env: TestEnv;
  let a: Tenant;
  let siteId: string;
  let decoy: Decoy;

  beforeAll(async () => {
    env = await createTestEnv();
    a = await createTenant(env, "ssrf-a");
    siteId = (await createSite(env, a)).id;
    decoy = await startDecoy();
  });
  afterAll(async () => {
    await decoy.stop();
    await env.close();
  });

  const snapshot = async (mockOpts: Record<string, unknown>) => {
    const mock = await env.startMock(mockOpts);
    const add = await addDevice(env, a, siteId, mock);
    expect(add.statusCode).toBe(201);
    const { cameras } = add.json() as { cameras: { id: string }[] };
    return env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
  };

  it("service addresses (XAddr) advertised by the device are pinned back to the device host", async () => {
    const hitsBefore = decoy.hits().length;
    const mock = await env.startMock({ xaddrBase: `http://${decoy.host}:${decoy.port}` });
    const add = await addDevice(env, a, siteId, mock);
    expect(add.statusCode).toBe(201);
    expect(decoy.hits().length).toBe(hitsBefore);
  });

  it.each(["localhost", "169.254.169.254", "10.255.255.1", "[::1]", "127.0.0.2"])(
    "snapshot URI on host %s is refused and the decoy is never contacted",
    async (host) => {
      const hitsBefore = decoy.hits().length;
      const res = await snapshot({ snapshotUriHost: host, snapshotUriPort: decoy.port });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { code: string }).code).toBe("snapshot_uri_host_mismatch");
      expect(decoy.hits().length).toBe(hitsBefore);
    },
  );

  it("same host but an arbitrary port is refused", async () => {
    const hitsBefore = decoy.hits().length;
    const res = await snapshot({ snapshotUriHost: "127.0.0.1", snapshotUriPort: decoy.port });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe("snapshot_uri_port_not_allowed");
    expect(decoy.hits().length).toBe(hitsBefore);
  });

  it("HTTP redirects are not followed", async () => {
    const hitsBefore = decoy.hits().length;
    const res = await snapshot({
      snapshotRedirectTo: `http://${decoy.host}:${decoy.port}/latest/meta-data/`,
    });
    expect(res.statusCode).toBe(502);
    expect(decoy.hits().length).toBe(hitsBefore);
  });

  it("non-http(s) snapshot schemes are refused", async () => {
    const res = await snapshot({ snapshotUriScheme: "file" });
    expect(res.statusCode).toBe(502);
  });

  it("targets outside the explicit policy are refused before any network access", async () => {
    for (const host of ["8.8.8.8", "169.254.169.254", "fd00:ec2::254", "224.0.0.251"]) {
      const res = await env.built.app.inject({
        method: "POST",
        url: "/v1/devices",
        headers: { cookie: a.cookie },
        payload: { siteId, name: "x", host, port: 80, username: "u", password: "p" },
      });
      expect(res.statusCode, host).toBe(422);
      expect((res.json() as { code: string }).code, host).toBe("target_not_allowed");
    }
  });

  it("lab exception: loopback is usable only with the explicit flag, in an isolated app instance", async () => {
    const strict = await createTestEnv({ ALLOW_LOOPBACK_TARGETS: "false" });
    try {
      const t = await createTenant(strict, "ssrf-strict");
      const s = await createSite(strict, t);
      const mock = await strict.startMock();
      const res = await addDevice(strict, t, s.id, mock);
      expect(res.statusCode).toBe(422);
      expect(mock.requests().length).toBe(0); // refused before touching the network
    } finally {
      await strict.close();
    }
    // and with the flag on (the default for this suite's env) the same mock works
    const mock = await env.startMock();
    expect((await addDevice(env, a, siteId, mock)).statusCode).toBe(201);
  });
});

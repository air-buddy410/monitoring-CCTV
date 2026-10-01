import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  giveAccess,
  type Tenant,
  type TestEnv,
} from "../helpers";

describe("tenant isolation (API level)", () => {
  let env: TestEnv;
  let a: Tenant;
  let b: Tenant;
  let deviceId: string;
  let cameraId: string;
  let siteA: string;
  let mock: Awaited<ReturnType<TestEnv["startMock"]>>;

  beforeAll(async () => {
    env = await createTestEnv();
    a = await createTenant(env, "tenant-a");
    b = await createTenant(env, "tenant-b");
    mock = await env.startMock({ channels: 2 });
    siteA = (await createSite(env, a)).id;
    const res = await addDevice(env, a, siteA, mock);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { device: { id: string }; cameras: { id: string }[] };
    deviceId = body.device.id;
    cameraId = body.cameras[0]?.id ?? "";
    expect(cameraId).toMatch(/^cam_/);
  });
  afterAll(async () => env.close());

  const inject = (t: Tenant | null, method: "GET" | "POST", url: string, payload?: unknown) =>
    env.built.app.inject({ method, url, headers: t ? { cookie: t.cookie } : {}, payload: payload as never });

  it("requires authentication (401 without session)", async () => {
    expect((await inject(null, "GET", "/v1/devices")).statusCode).toBe(401);
    expect((await inject(null, "GET", `/v1/devices/${deviceId}`)).statusCode).toBe(401);
    expect((await inject(null, "POST", `/v1/cameras/${cameraId}/snapshot`)).statusCode).toBe(401);
  });

  it("tenant A sees its own device and camera", async () => {
    expect((await inject(a, "GET", `/v1/devices/${deviceId}`)).statusCode).toBe(200);
    expect((await inject(a, "GET", `/v1/cameras/${cameraId}`)).statusCode).toBe(200);
  });

  it("tenant B gets 404 for A's device", async () => {
    const res = await inject(b, "GET", `/v1/devices/${deviceId}`);
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("tenant B gets 404 for A's camera", async () => {
    expect((await inject(b, "GET", `/v1/cameras/${cameraId}`)).statusCode).toBe(404);
  });

  it("tenant B gets 404 on A's snapshot and the mock camera is never contacted", async () => {
    const before = mock.snapshotRequestCount();
    const res = await inject(b, "POST", `/v1/cameras/${cameraId}/snapshot`);
    expect(res.statusCode).toBe(404);
    expect(mock.snapshotRequestCount()).toBe(before);
  });

  it("tenant B lists no devices/cameras/sites of A", async () => {
    const devices = (await inject(b, "GET", "/v1/devices")).json() as { items: unknown[] };
    const cameras = (await inject(b, "GET", "/v1/cameras")).json() as { items: unknown[] };
    const sites = (await inject(b, "GET", "/v1/sites")).json() as { items: unknown[] };
    expect(devices.items).toEqual([]);
    expect(cameras.items).toEqual([]);
    expect(sites.items).toEqual([]);
    const filtered = (await inject(b, "GET", `/v1/devices?siteId=${siteA}`)).json() as { items: unknown[] };
    expect(filtered.items).toEqual([]);
  });

  it("tenant B cannot add a device into A's site (404 site)", async () => {
    const res = await addDevice(env, b, siteA, mock);
    expect(res.statusCode).toBe(404);
  });

  it("organization id in the body is rejected, never trusted", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { cookie: b.cookie },
      payload: { name: "x", organizationId: a.orgId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("tenant B audit log never contains A's events", async () => {
    // B is not an owner of... B owns its own org, so it may read its own (empty of A) audit.
    const res = await inject(b, "GET", "/v1/audit");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { target: string }[] };
    expect(body.items.some((i) => i.target === deviceId || i.target === cameraId)).toBe(false);
  });

  it("a user whose active org they do not belong to is refused (membership re-checked)", async () => {
    // Forge: put B's user into A's session by moving B's active org to A directly in the DB.
    await env.admin.query(`update "session" set active_organization_id = $1 where user_id = $2`, [
      a.orgId,
      b.userId,
    ]);
    const res = await inject(b, "GET", `/v1/devices/${deviceId}`);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });

  it("role enforcement inside a tenant: viewer cannot add devices or take snapshots", async () => {
    const viewer = await addMemberWithRole(env, a, "viewer-a", "member");
    // default deny: a viewer sees the device only once the owner has granted its site
    expect((await inject(viewer, "GET", `/v1/devices/${deviceId}`)).statusCode).toBe(404);
    await giveAccess(env, a, viewer.userId, "site", siteA, "view");
    expect((await inject(viewer, "GET", `/v1/devices/${deviceId}`)).statusCode).toBe(200);
    const add = await addDevice(env, viewer, siteA, mock);
    expect(add.statusCode).toBe(403);
    expect((await inject(viewer, "POST", `/v1/cameras/${cameraId}/snapshot`)).statusCode).toBe(403);
    expect((await inject(viewer, "GET", "/v1/audit")).statusCode).toBe(403);
  });
});

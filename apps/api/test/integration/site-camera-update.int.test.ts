import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  type Tenant,
  type TestEnv,
} from "../helpers";

describe("site and camera updates (M1)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let operator: Tenant;
  let viewer: Tenant;
  let other: Tenant;
  let siteId: string;
  let cameraId: string;
  let deviceId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "upd-owner");
    operator = await addMemberWithRole(env, owner, "upd-operator", "admin");
    viewer = await addMemberWithRole(env, owner, "upd-viewer", "member");
    other = await createTenant(env, "upd-other");
    siteId = (await createSite(env, owner, "Site Awal")).id;
    const mock = await env.startMock({ channels: 1 });
    const add = await addDevice(env, owner, siteId, mock);
    const body = add.json() as { device: { id: string }; cameras: { id: string }[] };
    deviceId = body.device.id;
    cameraId = body.cameras[0]?.id ?? "";
  });
  afterAll(async () => env.close());

  const inject = (t: Tenant, method: string, url: string, payload?: unknown) =>
    env.built.app.inject({
      method: method as "PATCH" | "DELETE",
      url,
      headers: { cookie: t.cookie },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  it("PATCH /v1/sites/:id updates name/address/timezone and audits it", async () => {
    const res = await inject(owner, "PATCH", `/v1/sites/${siteId}`, {
      name: "Site Baru",
      address: "Jl. Uji 1",
      timezone: "Asia/Jakarta",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string; address: string | null; timezone: string };
    expect(body).toMatchObject({
      id: siteId,
      name: "Site Baru",
      address: "Jl. Uji 1",
      timezone: "Asia/Jakarta",
    });

    const list = await env.built.app.inject({
      method: "GET",
      url: "/v1/sites",
      headers: { cookie: owner.cookie },
    });
    const found = (list.json() as { items: { id: string; name: string }[] }).items.find(
      (s) => s.id === siteId,
    );
    expect(found?.name).toBe("Site Baru");

    const audit = await env.admin.query(
      `select action, target from audit_log where organization_id = $1 and action = 'site.update'`,
      [owner.orgId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].target).toBe(siteId);
  });

  it("PATCH site rejects an empty body and unknown fields (strict)", async () => {
    expect((await inject(owner, "PATCH", `/v1/sites/${siteId}`, {})).statusCode).toBe(400);
    expect((await inject(owner, "PATCH", `/v1/sites/${siteId}`, { id: "site_hack" })).statusCode).toBe(400);
    expect((await inject(owner, "PATCH", `/v1/sites/${siteId}`, { name: "" })).statusCode).toBe(400);
  });

  it("PATCH site: viewer 403, operator/owner allowed", async () => {
    expect((await inject(viewer, "PATCH", `/v1/sites/${siteId}`, { name: "x" })).statusCode).toBe(403);
    expect(
      (await inject(operator, "PATCH", `/v1/sites/${siteId}`, { name: "Site Operator" })).statusCode,
    ).toBe(200);
  });

  it("PATCH site: cross-tenant id is 404, never leaks or mutates", async () => {
    const res = await inject(other, "PATCH", `/v1/sites/${siteId}`, { name: "Hijack" });
    expect(res.statusCode).toBe(404);
    const row = await env.admin.query(`select name from site where id = $1`, [siteId]);
    expect(row.rows[0].name).toBe("Site Operator");
  });

  it("PATCH /v1/cameras/:id renames and reorders, and audits it", async () => {
    const res = await inject(owner, "PATCH", `/v1/cameras/${cameraId}`, {
      name: "Kamera Depan",
      sortOrder: 3,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: cameraId, name: "Kamera Depan", sortOrder: 3, deviceId });
    const audit = await env.admin.query(
      `select action from audit_log where organization_id = $1 and action = 'camera.update'`,
      [owner.orgId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("PATCH camera rejects attempts to move it to another device/channel (immutable fields)", async () => {
    expect(
      (await inject(owner, "PATCH", `/v1/cameras/${cameraId}`, { deviceId: "dev_other" })).statusCode,
    ).toBe(400);
    expect((await inject(owner, "PATCH", `/v1/cameras/${cameraId}`, { channel: "9" })).statusCode).toBe(400);
    expect((await inject(viewer, "PATCH", `/v1/cameras/${cameraId}`, { name: "n" })).statusCode).toBe(403);
    expect((await inject(other, "PATCH", `/v1/cameras/${cameraId}`, { name: "n" })).statusCode).toBe(404);
  });

  it("DELETE /v1/sites/:id removes the site with its devices and cameras", async () => {
    const tmpSite = (await createSite(env, owner, "Site Hapus")).id;
    const mock = await env.startMock({ channels: 1 });
    const add = await addDevice(env, owner, tmpSite, mock);
    const camId = (add.json() as { cameras: { id: string }[] }).cameras[0]?.id;
    expect(camId).toBeTruthy();

    const res = await inject(owner, "DELETE", `/v1/sites/${tmpSite}`);
    expect(res.statusCode).toBe(204);

    const gone = await env.built.app.inject({
      method: "GET",
      url: `/v1/devices/${(add.json() as { device: { id: string } }).device.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(gone.statusCode).toBe(404);
    const cam = await env.built.app.inject({
      method: "GET",
      url: `/v1/cameras/${camId}`,
      headers: { cookie: owner.cookie },
    });
    expect(cam.statusCode).toBe(404);
    const audit = await env.admin.query(
      `select action from audit_log where organization_id = $1 and action = 'site.delete'`,
      [owner.orgId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("DELETE site: viewer 403, cross-tenant 404, missing id 404", async () => {
    const s2 = (await createSite(env, owner, "Site Lain")).id;
    expect((await inject(viewer, "DELETE", `/v1/sites/${s2}`)).statusCode).toBe(403);
    expect((await inject(other, "DELETE", `/v1/sites/${s2}`)).statusCode).toBe(404);
    expect((await inject(owner, "DELETE", "/v1/sites/site_missing")).statusCode).toBe(404);
    expect((await inject(owner, "DELETE", `/v1/sites/${s2}`)).statusCode).toBe(204);
  });
});

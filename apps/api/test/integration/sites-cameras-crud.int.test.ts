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

describe("PATCH/DELETE /v1/sites/:id and PATCH /v1/cameras/:id", () => {
  let env: TestEnv;
  let owner: Tenant;
  let operator: Tenant;
  let viewer: Tenant;
  let noc: Tenant;
  let other: Tenant;
  const inject = (
    who: Tenant | null,
    method: "GET" | "PATCH" | "DELETE" | "POST",
    url: string,
    payload?: unknown,
  ) =>
    env.built.app.inject({
      method,
      url,
      headers: who ? { cookie: who.cookie } : {},
      payload: payload as never,
    });

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "crud-owner");
    operator = await addMemberWithRole(env, owner, "crud-operator", "admin");
    viewer = await addMemberWithRole(env, owner, "crud-viewer", "member");
    noc = await addMemberWithRole(env, owner, "crud-noc", "noc");
    other = await createTenant(env, "crud-other");
  });
  afterAll(async () => env.close());

  describe("sites", () => {
    it("patches name, address and timezone and returns the updated site", async () => {
      const s = await createSite(env, owner, "Lama");
      const res = await inject(owner, "PATCH", `/v1/sites/${s.id}`, {
        name: "Baru",
        address: "Jl. Dummy 1",
        timezone: "Asia/Jakarta",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: s.id,
        name: "Baru",
        address: "Jl. Dummy 1",
        timezone: "Asia/Jakarta",
      });
      const got = await inject(owner, "GET", `/v1/sites/${s.id}`);
      expect(got.statusCode).toBe(200);
      expect(got.json()).toMatchObject({ name: "Baru" });
    });

    it("allows clearing the address with null and keeps untouched fields", async () => {
      const s = await createSite(env, owner, "Alamat");
      await inject(owner, "PATCH", `/v1/sites/${s.id}`, { address: "X" });
      const res = await inject(owner, "PATCH", `/v1/sites/${s.id}`, { address: null });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "Alamat", address: null, timezone: "Asia/Makassar" });
    });

    it("rejects empty patches, unknown fields, organization_id in the body and bad timezones", async () => {
      const s = await createSite(env, owner);
      for (const payload of [
        {},
        { organizationId: other.orgId },
        { name: "" },
        { timezone: "Mars/Olympus" },
        { id: "x" },
      ]) {
        const res = await inject(owner, "PATCH", `/v1/sites/${s.id}`, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it("role matrix: viewer 403, operator and noc and owner may patch; delete is owner or noc only", async () => {
      const s = await createSite(env, owner);
      expect((await inject(null, "PATCH", `/v1/sites/${s.id}`, { name: "a" })).statusCode).toBe(401);
      expect((await inject(viewer, "PATCH", `/v1/sites/${s.id}`, { name: "a" })).statusCode).toBe(403);
      expect((await inject(operator, "PATCH", `/v1/sites/${s.id}`, { name: "b" })).statusCode).toBe(200);
      expect((await inject(noc, "PATCH", `/v1/sites/${s.id}`, { name: "c" })).statusCode).toBe(200);
      expect((await inject(null, "DELETE", `/v1/sites/${s.id}`)).statusCode).toBe(401);
      expect((await inject(viewer, "DELETE", `/v1/sites/${s.id}`)).statusCode).toBe(403);
      expect((await inject(operator, "DELETE", `/v1/sites/${s.id}`)).statusCode).toBe(403);
      expect((await inject(noc, "DELETE", `/v1/sites/${s.id}`)).statusCode).toBe(204);
      expect((await inject(owner, "GET", `/v1/sites/${s.id}`)).statusCode).toBe(404);
    });

    it("another tenant gets 404 on get, patch and delete, and nothing changes", async () => {
      const s = await createSite(env, owner, "Milik A");
      expect((await inject(other, "GET", `/v1/sites/${s.id}`)).statusCode).toBe(404);
      expect((await inject(other, "PATCH", `/v1/sites/${s.id}`, { name: "dibajak" })).statusCode).toBe(404);
      expect((await inject(other, "DELETE", `/v1/sites/${s.id}`)).statusCode).toBe(404);
      const row = await env.admin.query(`select name from site where id = $1`, [s.id]);
      expect(row.rows[0].name).toBe("Milik A");
    });

    it("delete cascades to devices and cameras and is audited without leaking anything", async () => {
      const s = await createSite(env, owner, "Dihapus");
      const mock = await env.startMock({ channels: 2 });
      const added = await addDevice(env, owner, s.id, mock);
      expect(added.statusCode).toBe(201);
      const res = await inject(owner, "DELETE", `/v1/sites/${s.id}`);
      expect(res.statusCode).toBe(204);
      const left = await env.admin.query(
        `select (select count(*) from device where site_id = $1) as d,
                (select count(*) from device_secret where organization_id = $2 and device_id = $3) as sec`,
        [s.id, owner.orgId, (added.json() as { device: { id: string } }).device.id],
      );
      expect(Number(left.rows[0].d)).toBe(0);
      expect(Number(left.rows[0].sec)).toBe(0);
      const audit = await env.admin.query(
        `select action, target, meta from audit_log where organization_id = $1 and action = 'site.delete' and target = $2`,
        [owner.orgId, s.id],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].meta).toMatchObject({ name: "Dihapus", devices: 1, cameras: 2 });
    });

    it("patch is audited with the changed field names, not their values", async () => {
      const s = await createSite(env, owner, "Audit Patch");
      await inject(owner, "PATCH", `/v1/sites/${s.id}`, { name: "Rahasia Baru", address: "Alamat Rahasia" });
      const audit = await env.admin.query(
        `select meta from audit_log where organization_id = $1 and action = 'site.update' and target = $2`,
        [owner.orgId, s.id],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].meta).toEqual({ fields: ["name", "address"] });
    });
  });

  describe("cameras", () => {
    let cameraId: string;
    let otherCameraId: string;
    beforeAll(async () => {
      const s = await createSite(env, owner);
      const mock = await env.startMock({ channels: 1 });
      cameraId =
        ((await addDevice(env, owner, s.id, mock)).json() as { cameras: { id: string }[] }).cameras[0]?.id ??
        "";
      const so = await createSite(env, other);
      const mock2 = await env.startMock({ channels: 1 });
      otherCameraId =
        ((await addDevice(env, other, so.id, mock2)).json() as { cameras: { id: string }[] }).cameras[0]
          ?.id ?? "";
    });

    it("renames and reorders a camera", async () => {
      const res = await inject(owner, "PATCH", `/v1/cameras/${cameraId}`, {
        name: "Pintu Depan",
        sortOrder: 7,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: cameraId, name: "Pintu Depan", sortOrder: 7 });
      expect(((await inject(owner, "GET", `/v1/cameras/${cameraId}`)).json() as { name: string }).name).toBe(
        "Pintu Depan",
      );
    });

    it("only name and sortOrder are editable: capabilities, device, channel and tenant are rejected", async () => {
      for (const payload of [
        {},
        { hasPtz: true },
        { channel: "9" },
        { deviceId: "dev_x" },
        { organizationId: other.orgId },
        { sortOrder: -1 },
        { name: " " },
      ]) {
        const res = await inject(owner, "PATCH", `/v1/cameras/${cameraId}`, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it("role matrix: viewer 403, operator, noc and owner allowed", async () => {
      expect((await inject(null, "PATCH", `/v1/cameras/${cameraId}`, { name: "a" })).statusCode).toBe(401);
      expect((await inject(viewer, "PATCH", `/v1/cameras/${cameraId}`, { name: "a" })).statusCode).toBe(403);
      expect((await inject(operator, "PATCH", `/v1/cameras/${cameraId}`, { name: "b" })).statusCode).toBe(
        200,
      );
      expect((await inject(noc, "PATCH", `/v1/cameras/${cameraId}`, { name: "c" })).statusCode).toBe(200);
    });

    it("another tenant cannot read or edit it", async () => {
      expect((await inject(other, "PATCH", `/v1/cameras/${cameraId}`, { name: "dibajak" })).statusCode).toBe(
        404,
      );
      expect(
        (await inject(owner, "PATCH", `/v1/cameras/${otherCameraId}`, { name: "dibajak" })).statusCode,
      ).toBe(404);
      const row = await env.admin.query(`select name from camera where id = $1`, [otherCameraId]);
      expect(row.rows[0].name).not.toBe("dibajak");
    });

    it("is audited as camera.update with field names only", async () => {
      await inject(owner, "PATCH", `/v1/cameras/${cameraId}`, { name: "Nama Audit" });
      const audit = await env.admin.query(
        `select meta from audit_log where organization_id = $1 and action = 'camera.update' and target = $2 order by at desc limit 1`,
        [owner.orgId, cameraId],
      );
      expect(audit.rows[0].meta).toEqual({ fields: ["name"] });
    });
  });
});

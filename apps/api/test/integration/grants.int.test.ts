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

interface Grant {
  id: string;
  userId: string;
  scope: "site" | "camera";
  scopeId: string;
  permission: "view" | "operate";
  createdAt: string;
}

describe("camera grants (/v1/grants)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let viewer: Tenant;
  let other: Tenant;
  let siteId: string;
  let cameraId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "grant-owner");
    viewer = await addMemberWithRole(env, owner, "grant-viewer", "member");
    other = await createTenant(env, "grant-other");
    siteId = (await createSite(env, owner, "Site Grant")).id;
    const mock = await env.startMock({ channels: 1 });
    const add = await addDevice(env, owner, siteId, mock);
    cameraId = (add.json() as { cameras: { id: string }[] }).cameras[0]?.id ?? "";
  });
  afterAll(async () => env.close());

  const call = (t: Tenant, method: string, url: string, payload?: unknown) =>
    env.built.app.inject({
      method: method as "GET" | "POST" | "DELETE",
      url,
      headers: { cookie: t.cookie },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  it("owner grants a camera to a member and it is listed with the right shape", async () => {
    const res = await call(owner, "POST", "/v1/grants", {
      userId: viewer.userId,
      scope: "camera",
      scopeId: cameraId,
      permission: "view",
    });
    expect(res.statusCode).toBe(201);
    const g = res.json() as Grant;
    expect(g).toMatchObject({
      userId: viewer.userId,
      scope: "camera",
      scopeId: cameraId,
      permission: "view",
    });
    expect(g.id).toMatch(/^grt_/);
    expect(typeof g.createdAt).toBe("string");

    const list = await call(owner, "GET", "/v1/grants");
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Grant[] }).items.some((x) => x.id === g.id)).toBe(true);
  });

  it("audits grant creation", async () => {
    const audit = await env.admin.query(
      `select action from audit_log where organization_id = $1 and action = 'grant.create'`,
      [owner.orgId],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });

  it("rejects a grant for a user who is not a member of the tenant", async () => {
    const res = await call(owner, "POST", "/v1/grants", {
      userId: other.userId,
      scope: "camera",
      scopeId: cameraId,
      permission: "view",
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects a scope id that does not belong to the tenant", async () => {
    const res = await call(owner, "POST", "/v1/grants", {
      userId: viewer.userId,
      scope: "camera",
      scopeId: "cam_does_not_exist",
      permission: "view",
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects unknown fields and invalid enums (strict)", async () => {
    expect(
      (
        await call(owner, "POST", "/v1/grants", {
          userId: viewer.userId,
          scope: "camera",
          scopeId: cameraId,
          permission: "admin",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(owner, "POST", "/v1/grants", {
          userId: viewer.userId,
          scope: "camera",
          scopeId: cameraId,
          permission: "view",
          extra: 1,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("is owner-only: operator and viewer cannot list or create", async () => {
    const op = await addMemberWithRole(env, owner, "grant-op", "admin");
    expect((await call(op, "GET", "/v1/grants")).statusCode).toBe(403);
    expect(
      (
        await call(op, "POST", "/v1/grants", {
          userId: viewer.userId,
          scope: "site",
          scopeId: siteId,
          permission: "view",
        })
      ).statusCode,
    ).toBe(403);
    expect((await call(viewer, "GET", "/v1/grants")).statusCode).toBe(403);
  });

  it("never leaks another tenant's grants and cannot touch their ids", async () => {
    const otherSite = (await createSite(env, other, "Site Other")).id;
    const mine = ((await call(owner, "GET", "/v1/grants")).json() as { items: Grant[] }).items;
    const otherList = await call(other, "GET", "/v1/grants");
    expect((otherList.json() as { items: Grant[] }).items).toHaveLength(0);
    // deleting a foreign grant id is a 404, and it must still exist for the owner
    const foreign = await call(other, "DELETE", `/v1/grants/${mine[0]?.id}`);
    expect(foreign.statusCode).toBe(404);
    expect(((await call(owner, "GET", "/v1/grants")).json() as { items: Grant[] }).items).toHaveLength(
      mine.length,
    );
    expect(otherSite).toBeTruthy();
  });

  it("owner deletes a grant and it disappears", async () => {
    const created = (
      await call(owner, "POST", "/v1/grants", {
        userId: viewer.userId,
        scope: "site",
        scopeId: siteId,
        permission: "operate",
      })
    ).json() as Grant;
    const del = await call(owner, "DELETE", `/v1/grants/${created.id}`);
    expect(del.statusCode).toBe(204);
    const list = (await call(owner, "GET", "/v1/grants")).json() as { items: Grant[] };
    expect(list.items.find((x) => x.id === created.id)).toBeUndefined();
    expect((await call(owner, "DELETE", `/v1/grants/${created.id}`)).statusCode).toBe(404);
  });
});

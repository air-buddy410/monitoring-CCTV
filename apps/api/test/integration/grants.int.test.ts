import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
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
  createdBy: string | null;
}

describe("/v1/grants (per-camera access)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let operator: Tenant;
  let viewer: Tenant;
  let noc: Tenant;
  let other: Tenant;
  let siteId: string;
  let cameraId: string;
  let otherCameraId: string;
  let otherSiteId: string;

  const call = (who: Tenant | null, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    env.built.app.inject({
      method,
      url,
      headers: who ? { cookie: who.cookie } : {},
      payload: payload as never,
    });
  const grant = (who: Tenant, body: unknown) => call(who, "POST", "/v1/grants", body);

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "gr-owner");
    operator = await addMemberWithRole(env, owner, "gr-operator", "admin");
    viewer = await addMemberWithRole(env, owner, "gr-viewer", "member");
    noc = await addMemberWithRole(env, owner, "gr-noc", "noc");
    other = await createTenant(env, "gr-other");
    siteId = (await createSite(env, owner)).id;
    const mock = await env.startMock({ channels: 2 });
    cameraId =
      ((await addDevice(env, owner, siteId, mock)).json() as { cameras: { id: string }[] }).cameras[0]?.id ??
      "";
    otherSiteId = (await createSite(env, other)).id;
    const mock2 = await env.startMock({ channels: 1 });
    otherCameraId =
      ((await addDevice(env, other, otherSiteId, mock2)).json() as { cameras: { id: string }[] }).cameras[0]
        ?.id ?? "";
  });
  afterAll(async () => env.close());

  describe("create, list, delete", () => {
    it("owner grants a camera to a viewer and the grant lists back", async () => {
      const res = await grant(owner, {
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
        createdBy: owner.userId,
      });
      expect(g.id).toMatch(/^grt_/);
      const list = (await call(owner, "GET", "/v1/grants")).json() as { items: Grant[] };
      expect(list.items.map((x) => x.id)).toContain(g.id);
    });

    it("filters by userId, scope and scopeId", async () => {
      await grant(owner, { userId: operator.userId, scope: "site", scopeId: siteId, permission: "operate" });
      const byUser = (await call(owner, "GET", `/v1/grants?userId=${operator.userId}`)).json() as {
        items: Grant[];
      };
      expect(byUser.items.length).toBeGreaterThan(0);
      expect(byUser.items.every((g) => g.userId === operator.userId)).toBe(true);
      const bySite = (await call(owner, "GET", `/v1/grants?scope=site&scopeId=${siteId}`)).json() as {
        items: Grant[];
      };
      expect(bySite.items.every((g) => g.scope === "site" && g.scopeId === siteId)).toBe(true);
    });

    it("a second grant for the same user and target is a conflict, not a silent duplicate", async () => {
      const body = { userId: viewer.userId, scope: "camera", scopeId: cameraId, permission: "operate" };
      const res = await grant(owner, body);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { code: string }).code).toBe("grant_exists");
    });

    it("delete removes it (204), a repeat is 404", async () => {
      const g = (
        await grant(owner, { userId: viewer.userId, scope: "site", scopeId: siteId, permission: "view" })
      ).json() as Grant;
      expect((await call(owner, "DELETE", `/v1/grants/${g.id}`)).statusCode).toBe(204);
      expect((await call(owner, "DELETE", `/v1/grants/${g.id}`)).statusCode).toBe(404);
    });

    it("validates the body: strict, enum values, no organizationId, no unknown fields", async () => {
      const ok = { userId: viewer.userId, scope: "camera", scopeId: cameraId, permission: "view" };
      for (const bad of [
        { ...ok, organizationId: owner.orgId },
        { ...ok, scope: "device" },
        { ...ok, permission: "admin" },
        { ...ok, extra: 1 },
        { userId: viewer.userId, scope: "camera", permission: "view" },
        {},
      ]) {
        expect((await grant(owner, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
    });

    it("the grantee must be a member of this organization", async () => {
      const res = await grant(owner, {
        userId: other.userId,
        scope: "camera",
        scopeId: cameraId,
        permission: "view",
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { code: string }).code).toBe("member_not_found");
    });

    it("the target must exist in this tenant (site or camera)", async () => {
      const missing = await grant(owner, {
        userId: viewer.userId,
        scope: "camera",
        scopeId: "cam_nope",
        permission: "view",
      });
      expect(missing.statusCode).toBe(404);
      expect((missing.json() as { code: string }).code).toBe("camera_not_found");
      const siteMissing = await grant(owner, {
        userId: viewer.userId,
        scope: "site",
        scopeId: "site_nope",
        permission: "view",
      });
      expect(siteMissing.statusCode).toBe(404);
    });
  });

  describe("roles", () => {
    it("owner and noc may manage; operator and viewer may not", async () => {
      const body = {
        userId: viewer.userId,
        scope: "camera",
        scopeId: (await camerasOf(siteId))[1] ?? "",
        permission: "view",
      };
      expect((await grant(null as never, body)).statusCode).toBe(401);
      expect((await grant(viewer, body)).statusCode).toBe(403);
      expect((await grant(operator, body)).statusCode).toBe(403);
      const made = await grant(noc, body);
      expect(made.statusCode).toBe(201);
      const id = (made.json() as Grant).id;
      expect((await call(viewer, "DELETE", `/v1/grants/${id}`)).statusCode).toBe(403);
      expect((await call(operator, "DELETE", `/v1/grants/${id}`)).statusCode).toBe(403);
      expect((await call(noc, "DELETE", `/v1/grants/${id}`)).statusCode).toBe(204);
    });

    it("non-managers see only their own grants and may not ask for another user's", async () => {
      await grant(owner, {
        userId: operator.userId,
        scope: "camera",
        scopeId: cameraId,
        permission: "operate",
      });
      await grant(owner, { userId: viewer.userId, scope: "site", scopeId: siteId, permission: "view" }).catch(
        () => undefined,
      );
      const mine = (await call(viewer, "GET", "/v1/grants")).json() as { items: Grant[] };
      expect(mine.items.length).toBeGreaterThan(0);
      expect(mine.items.every((g) => g.userId === viewer.userId)).toBe(true);
      expect((await call(viewer, "GET", `/v1/grants?userId=${operator.userId}`)).statusCode).toBe(403);
      expect((await call(viewer, "GET", `/v1/grants?userId=${viewer.userId}`)).statusCode).toBe(200);
    });

    it("an operator cannot grant themselves more access through any route", async () => {
      const before = await env.admin.query(`select count(*)::int as n from camera_grant where user_id = $1`, [
        operator.userId,
      ]);
      const res = await grant(operator, {
        userId: operator.userId,
        scope: "site",
        scopeId: siteId,
        permission: "operate",
      });
      expect(res.statusCode).toBe(403);
      const after = await env.admin.query(`select count(*)::int as n from camera_grant where user_id = $1`, [
        operator.userId,
      ]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });
  });

  async function camerasOf(site: string): Promise<string[]> {
    const r = (await call(owner, "GET", `/v1/cameras?siteId=${site}`)).json() as { items: { id: string }[] };
    return r.items.map((c) => c.id);
  }

  describe("tenant isolation", () => {
    it("tenant B cannot list, read or delete tenant A's grants and cannot grant A's targets", async () => {
      const g = (
        await grant(owner, { userId: noc.userId, scope: "camera", scopeId: cameraId, permission: "view" })
      ).json() as Grant;
      const bList = (await call(other, "GET", "/v1/grants")).json() as { items: Grant[] };
      expect(bList.items.find((x) => x.id === g.id)).toBeUndefined();
      expect((await call(other, "DELETE", `/v1/grants/${g.id}`)).statusCode).toBe(404);
      const still = await env.admin.query(`select 1 from camera_grant where id = $1`, [g.id]);
      expect(still.rowCount).toBe(1);
      // B owner grants B's member a camera that belongs to A
      const bMember = await addMemberWithRole(env, other, "gr-bmember", "member");
      const res = await grant(other, {
        userId: bMember.userId,
        scope: "camera",
        scopeId: cameraId,
        permission: "view",
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { code: string }).code).toBe("camera_not_found");
      // A owner grants A's member a camera that belongs to B
      const cross = await grant(owner, {
        userId: viewer.userId,
        scope: "camera",
        scopeId: otherCameraId,
        permission: "view",
      });
      expect(cross.statusCode).toBe(404);
      expect(
        (await env.admin.query(`select 1 from camera_grant where scope_id = $1`, [otherCameraId])).rowCount,
      ).toBe(0);
    });

    it("RLS on camera_grant: the application role sees nothing without a tenant and only its own tenant with one", async () => {
      const urls = inject("dbUrls");
      const app = new pg.Pool({ connectionString: urls.app, max: 1 });
      try {
        const none = await app.query("select * from camera_grant");
        expect(none.rowCount).toBe(0);
        const c = await app.connect();
        try {
          await c.query("begin");
          await c.query("select set_config('app.org_id', $1, true)", [other.orgId]);
          const mine = await c.query("select organization_id from camera_grant");
          expect(mine.rows.every((r) => r.organization_id === other.orgId)).toBe(true);
          await expect(
            c.query(
              `insert into camera_grant (id, organization_id, user_id, scope, scope_id, permission)
               values ($1,$2,$3,'camera',$4,'view')`,
              [`grt_${randomUUID()}`, owner.orgId, viewer.userId, cameraId],
            ),
          ).rejects.toThrow(/row-level security/);
        } finally {
          await c.query("rollback").catch(() => undefined);
          c.release();
        }
      } finally {
        await app.end();
      }
    });

    it("camera_grant has RLS enabled and forced", async () => {
      const r = await env.admin.query(
        `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'camera_grant' and relkind = 'r'`,
      );
      expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  describe("lifecycle", () => {
    it("deleting a camera, a site or a member removes their grants", async () => {
      const s = await createSite(env, owner, "Siklus");
      const mock = await env.startMock({ channels: 1 });
      const cams = ((await addDevice(env, owner, s.id, mock)).json() as { cameras: { id: string }[] })
        .cameras;
      const m = await addMemberWithRole(env, owner, "gr-life", "member");
      await grant(owner, { userId: m.userId, scope: "site", scopeId: s.id, permission: "view" });
      await grant(owner, { userId: m.userId, scope: "camera", scopeId: cams[0]?.id, permission: "view" });
      const count = async () =>
        Number(
          (
            await env.admin.query(`select count(*) from camera_grant where scope_id = any($1)`, [
              [s.id, cams[0]?.id],
            ])
          ).rows[0].count,
        );
      expect(await count()).toBe(2);
      expect((await call(owner, "DELETE", `/v1/sites/${s.id}`)).statusCode).toBe(204);
      expect(await count()).toBe(0);
      await env.admin.query(`delete from "member" where user_id = $1 and organization_id = $2`, [
        m.userId,
        owner.orgId,
      ]);
      expect(
        Number(
          (await env.admin.query(`select count(*) from camera_grant where user_id = $1`, [m.userId])).rows[0]
            .count,
        ),
      ).toBe(0);
    });
  });

  describe("enforcement on snapshot (video access)", () => {
    let opCam: string;
    let opSite: string;
    let op: Tenant;
    beforeAll(async () => {
      opSite = (await createSite(env, owner, "Enforce")).id;
      const mock = await env.startMock({ channels: 2 });
      const cams = ((await addDevice(env, owner, opSite, mock)).json() as { cameras: { id: string }[] })
        .cameras;
      opCam = cams[0]?.id ?? "";
      op = await addMemberWithRole(env, owner, "gr-op2", "admin");
    });
    const snap = (who: Tenant, id: string) => call(who, "POST", `/v1/cameras/${id}/snapshot`);
    const reason = async (userId: string) =>
      (
        await env.admin.query(
          `select meta from audit_log where actor_id = $1 and action = 'camera.snapshot.denied' order by at desc limit 1`,
          [userId],
        )
      ).rows[0]?.meta;

    it("an operator with no grant is denied (default deny) and the denial is audited", async () => {
      const res = await snap(op, opCam);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { code: string }).code).toBe("camera_not_granted");
      expect(await reason(op.userId)).toMatchObject({ reason: "no_grant" });
    });

    it("a view-only grant is not enough for a snapshot", async () => {
      const g = (
        await grant(owner, { userId: op.userId, scope: "camera", scopeId: opCam, permission: "view" })
      ).json() as Grant;
      const res = await snap(op, opCam);
      expect(res.statusCode).toBe(403);
      expect(await reason(op.userId)).toMatchObject({ reason: "view_only" });
      await call(owner, "DELETE", `/v1/grants/${g.id}`);
    });

    it("an operate grant on the camera, or on its site, allows it; revoking closes it again", async () => {
      const g1 = (
        await grant(owner, { userId: op.userId, scope: "camera", scopeId: opCam, permission: "operate" })
      ).json() as Grant;
      expect((await snap(op, opCam)).statusCode).toBe(200);
      await call(owner, "DELETE", `/v1/grants/${g1.id}`);
      expect((await snap(op, opCam)).statusCode).toBe(403);
      const g2 = (
        await grant(owner, { userId: op.userId, scope: "site", scopeId: opSite, permission: "operate" })
      ).json() as Grant;
      expect((await snap(op, opCam)).statusCode).toBe(200);
      await call(owner, "DELETE", `/v1/grants/${g2.id}`);
      expect((await snap(op, opCam)).statusCode).toBe(403);
    });

    it("a grant on one camera does not open its sibling", async () => {
      const sibling = (await camerasOf(opSite)).find((c) => c !== opCam) ?? "";
      const g = (
        await grant(owner, { userId: op.userId, scope: "camera", scopeId: opCam, permission: "operate" })
      ).json() as Grant;
      expect((await snap(op, sibling)).statusCode).toBe(403);
      await call(owner, "DELETE", `/v1/grants/${g.id}`);
    });

    it("the owner needs no grant; noc never gets video even with a grant", async () => {
      expect((await snap(owner, opCam)).statusCode).toBe(200);
      await grant(owner, { userId: noc.userId, scope: "site", scopeId: opSite, permission: "operate" });
      expect((await snap(noc, opCam)).statusCode).toBe(403);
    });

    it("a grant in another tenant never counts", async () => {
      const bOp = await addMemberWithRole(env, other, "gr-bop", "admin");
      expect((await snap(bOp, opCam)).statusCode).toBe(404);
    });
  });
});

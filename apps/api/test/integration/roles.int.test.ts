import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  giveAccess,
  ORIGIN,
  type Tenant,
  type TestEnv,
} from "../helpers";

type Who = "none" | "viewer" | "operator" | "owner";

describe("role matrix (owner / operator / viewer)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let operator: Tenant;
  let viewer: Tenant;
  let siteId: string;
  let cameraId: string;
  let deviceId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "role-owner");
    operator = await addMemberWithRole(env, owner, "role-operator", "admin");
    viewer = await addMemberWithRole(env, owner, "role-viewer", "member");
    siteId = (await createSite(env, owner)).id;
    const mock = await env.startMock({ channels: 1 });
    const add = await addDevice(env, owner, siteId, mock);
    const body = add.json() as { device: { id: string }; cameras: { id: string }[] };
    deviceId = body.device.id;
    cameraId = body.cameras[0]?.id ?? "";
    // Grants narrow video access (default deny for operator and viewer), so the operator is granted this camera.
    const granted = await env.built.app.inject({
      method: "POST",
      url: "/v1/grants",
      headers: { cookie: owner.cookie },
      payload: { userId: operator.userId, scope: "camera", scopeId: cameraId, permission: "operate" },
    });
    expect(granted.statusCode).toBe(201);
    // Inventory is default-deny too: operator may operate the site, viewer may view it.
    await giveAccess(env, owner, operator.userId, "site", siteId, "operate");
    await giveAccess(env, owner, viewer.userId, "site", siteId, "view");
  });
  afterAll(async () => env.close());

  const as = (w: Who): Record<string, string> =>
    w === "none" ? {} : { cookie: { viewer, operator, owner }[w].cookie };

  // [method, url builder, allowed roles]
  const endpoints: [string, string, () => string, () => unknown, Who[]][] = [
    ["GET", "list sites", () => "/v1/sites", () => undefined, ["viewer", "operator", "owner"]],
    ["GET", "list devices", () => "/v1/devices", () => undefined, ["viewer", "operator", "owner"]],
    ["GET", "get device", () => `/v1/devices/${deviceId}`, () => undefined, ["viewer", "operator", "owner"]],
    ["GET", "list cameras", () => "/v1/cameras", () => undefined, ["viewer", "operator", "owner"]],
    ["GET", "get camera", () => `/v1/cameras/${cameraId}`, () => undefined, ["viewer", "operator", "owner"]],
    ["POST", "create site", () => "/v1/sites", () => ({ name: "matrix-site" }), ["operator", "owner"]],
    ["POST", "snapshot", () => `/v1/cameras/${cameraId}/snapshot`, () => undefined, ["operator", "owner"]],
    ["GET", "audit", () => "/v1/audit", () => undefined, ["owner"]],
  ];

  for (const [method, label, url, payload, allowed] of endpoints) {
    for (const who of ["none", "viewer", "operator", "owner"] as Who[]) {
      const expectOk = allowed.includes(who);
      it(`${label}: ${who} -> ${who === "none" ? "401" : expectOk ? "allowed" : "403"}`, async () => {
        const res = await env.built.app.inject({
          method: method as "GET" | "POST",
          url: url(),
          headers: as(who),
          payload: payload() as never,
        });
        if (who === "none") expect(res.statusCode).toBe(401);
        else if (expectOk) expect([200, 201]).toContain(res.statusCode);
        else expect(res.statusCode).toBe(403);
      });
    }
  }

  it("add device: viewer 403, operator and owner allowed", async () => {
    const mock = await env.startMock();
    expect((await addDevice(env, viewer, siteId, mock)).statusCode).toBe(403);
    expect((await addDevice(env, operator, siteId, mock)).statusCode).toBe(201);
    expect((await addDevice(env, owner, siteId, mock)).statusCode).toBe(201);
  });

  it("a denied viewer request has no side effects (nothing probed, nothing audited as success)", async () => {
    const mock = await env.startMock();
    const before = mock.requests().length;
    await addDevice(env, viewer, siteId, mock);
    await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameraId}/snapshot`,
      headers: as("viewer"),
    });
    expect(mock.requests().length).toBe(before);
    const audit = await env.admin.query(
      `select action from audit_log where actor_id = $1 and action in ('device.create','camera.snapshot')`,
      [viewer.userId],
    );
    expect(audit.rowCount).toBe(0);
  });

  it("viewer cannot self-promote through Better Auth organization endpoints", async () => {
    const memberRow = await env.admin.query(
      `select id from "member" where organization_id = $1 and user_id = $2`,
      [owner.orgId, viewer.userId],
    );
    const memberId = memberRow.rows[0].id as string;
    const attempts = [
      {
        url: "/api/auth/organization/update-member-role",
        payload: { memberId, role: "owner", organizationId: owner.orgId },
      },
      {
        url: "/api/auth/organization/update-member-role",
        payload: { memberId, role: "admin", organizationId: owner.orgId },
      },
      {
        url: "/api/auth/organization/invite-member",
        payload: { email: "x@example.test", role: "owner", organizationId: owner.orgId },
      },
    ];
    for (const a of attempts) {
      const res = await env.built.app.inject({
        method: "POST",
        url: a.url,
        headers: { ...as("viewer"), origin: ORIGIN },
        payload: a.payload,
      });
      expect(res.statusCode, `${a.url} ${JSON.stringify(a.payload)}`).toBeGreaterThanOrEqual(400);
    }
    const role = await env.admin.query(`select role from "member" where id = $1`, [memberId]);
    expect(role.rows[0].role).toBe("member");
    // and the API still treats them as a viewer
    const mock = await env.startMock();
    expect((await addDevice(env, viewer, siteId, mock)).statusCode).toBe(403);
  });

  it("viewer cannot switch the active organization to one they do not belong to", async () => {
    const other = await createTenant(env, "role-other");
    const res = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { ...as("viewer"), origin: ORIGIN },
      payload: { organizationId: other.orgId },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // fail closed: Better Auth drops the active org after the refused switch, so the API answers 403;
    // if a client ever kept its old active org it must still see only that org. Never the other tenant.
    const devices = await env.built.app.inject({ method: "GET", url: "/v1/devices", headers: as("viewer") });
    expect([200, 403]).toContain(devices.statusCode);
    if (devices.statusCode === 200) {
      const ids = (devices.json() as { items: { id: string }[] }).items.map((d) => d.id);
      expect(ids).toContain(deviceId);
    } else {
      expect((devices.json() as { code: string }).code).toBe("no_active_organization");
    }
  });
});

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

interface Item {
  id: string;
}

describe("grants narrow the inventory too: operators and viewers see only what they were given", () => {
  let env: TestEnv;
  let owner: Tenant;
  let noc: Tenant;
  let other: Tenant;
  let s1: string;
  let s2: string;
  let d1: string;
  let d2: string;
  let c1: string;
  let c2: string;
  let c3: string;

  const call = (who: Tenant, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    env.built.app.inject({ method, url, headers: { cookie: who.cookie }, payload: payload as never });
  const ids = async (who: Tenant, url: string) =>
    ((await call(who, "GET", url)).json() as { items: Item[] }).items.map((i) => i.id).sort();
  const grant = async (
    userId: string,
    scope: "site" | "camera",
    scopeId: string,
    permission: "view" | "operate",
  ) => {
    const res = await call(owner, "POST", "/v1/grants", { userId, scope, scopeId, permission });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as Item).id;
  };
  const member = (label: string, role: "admin" | "member") =>
    addMemberWithRole(env, owner, `${label}-${Math.random().toString(36).slice(2, 6)}`, role);

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "inv-owner");
    noc = await addMemberWithRole(env, owner, "inv-noc", "noc");
    other = await createTenant(env, "inv-other");
    s1 = (await createSite(env, owner, "Lokasi Satu")).id;
    s2 = (await createSite(env, owner, "Lokasi Dua")).id;
    const m1 = await env.startMock({ channels: 2 });
    const m2 = await env.startMock({ channels: 1 });
    const a = (await addDevice(env, owner, s1, m1, { name: "Alat Satu" })).json() as {
      device: Item;
      cameras: Item[];
    };
    const b = (await addDevice(env, owner, s2, m2, { name: "Alat Dua" })).json() as {
      device: Item;
      cameras: Item[];
    };
    d1 = a.device.id;
    d2 = b.device.id;
    [c1, c2] = [a.cameras[0]?.id as string, a.cameras[1]?.id as string];
    c3 = b.cameras[0]?.id as string;
  });
  afterAll(async () => env.close());

  it("without any grant an operator and a viewer see an empty inventory and 404 on every id", async () => {
    for (const who of [await member("op0", "admin"), await member("vw0", "member")]) {
      for (const url of [
        "/v1/sites",
        "/v1/devices",
        "/v1/cameras",
        `/v1/devices?siteId=${s1}`,
        `/v1/cameras?siteId=${s1}`,
      ]) {
        expect(await ids(who, url), url).toEqual([]);
      }
      for (const url of [`/v1/sites/${s1}`, `/v1/devices/${d1}`, `/v1/cameras/${c1}`]) {
        expect((await call(who, "GET", url)).statusCode, url).toBe(404);
      }
    }
  });

  it("owner and noc see the whole tenant inventory (noc is not narrowed, and gets no video)", async () => {
    for (const who of [owner, noc]) {
      expect(await ids(who, "/v1/sites")).toEqual([s1, s2].sort());
      expect(await ids(who, "/v1/devices")).toEqual([d1, d2].sort());
      expect(await ids(who, "/v1/cameras")).toEqual([c1, c2, c3].sort());
    }
  });

  it("a camera grant shows that camera, its device (with only that camera) and its site, nothing else", async () => {
    const vw = await member("vw1", "member");
    await grant(vw.userId, "camera", c1, "view");
    expect(await ids(vw, "/v1/cameras")).toEqual([c1]);
    expect(await ids(vw, "/v1/devices")).toEqual([d1]);
    expect(await ids(vw, "/v1/sites")).toEqual([s1]);
    const dev = (await call(vw, "GET", `/v1/devices/${d1}`)).json() as { cameras: Item[] };
    expect(dev.cameras.map((c) => c.id)).toEqual([c1]);
    expect((await call(vw, "GET", `/v1/cameras/${c2}`)).statusCode).toBe(404);
    expect((await call(vw, "GET", `/v1/cameras/${c3}`)).statusCode).toBe(404);
    expect((await call(vw, "GET", `/v1/devices/${d2}`)).statusCode).toBe(404);
    expect(await ids(vw, `/v1/cameras?siteId=${s2}`)).toEqual([]);
  });

  it("a site grant shows everything in that site and nothing in the other", async () => {
    const op = await member("op2", "admin");
    await grant(op.userId, "site", s2, "operate");
    expect(await ids(op, "/v1/sites")).toEqual([s2]);
    expect(await ids(op, "/v1/devices")).toEqual([d2]);
    expect(await ids(op, "/v1/cameras")).toEqual([c3]);
    expect((await call(op, "GET", `/v1/devices/${d1}`)).statusCode).toBe(404);
  });

  it("a grant on one camera does not reveal a sibling on the same device", async () => {
    const vw = await member("vw3", "member");
    await grant(vw.userId, "camera", c2, "view");
    expect(await ids(vw, "/v1/cameras")).toEqual([c2]);
    expect((await call(vw, "GET", `/v1/cameras/${c1}`)).statusCode).toBe(404);
  });

  it("revoking a grant removes the visibility at once", async () => {
    const vw = await member("vw4", "member");
    const g = await grant(vw.userId, "site", s1, "view");
    expect(await ids(vw, "/v1/cameras")).toEqual([c1, c2].sort());
    expect((await call(owner, "DELETE", `/v1/grants/${g}`)).statusCode).toBe(204);
    expect(await ids(vw, "/v1/cameras")).toEqual([]);
    expect((await call(vw, "GET", `/v1/devices/${d1}`)).statusCode).toBe(404);
  });

  it("PATCH camera: a view-only grant is refused, an operate grant works, an ungranted camera is 404", async () => {
    const op = await member("op5", "admin");
    await grant(op.userId, "camera", c1, "view");
    const refused = await call(op, "PATCH", `/v1/cameras/${c1}`, { name: "Ditolak" });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe("camera_not_granted");
    expect((await call(op, "PATCH", `/v1/cameras/${c3}`, { name: "Tak terlihat" })).statusCode).toBe(404);
    await grant(op.userId, "camera", c2, "operate");
    expect((await call(op, "PATCH", `/v1/cameras/${c2}`, { name: "Boleh" })).statusCode).toBe(200);
    const row = await env.admin.query(`select name from camera where id = $1`, [c1]);
    expect(row.rows[0].name).not.toBe("Ditolak");
  });

  it("PATCH site needs an operate grant on the site itself, not just on a camera inside it", async () => {
    const op = await member("op6", "admin");
    await grant(op.userId, "camera", c1, "operate");
    const refused = await call(op, "PATCH", `/v1/sites/${s1}`, { name: "Dibajak" });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe("site_not_granted");
    expect((await call(op, "PATCH", `/v1/sites/${s2}`, { name: "x" })).statusCode).toBe(404);
    await grant(op.userId, "site", s1, "operate");
    expect((await call(op, "PATCH", `/v1/sites/${s1}`, { name: "Lokasi Satu" })).statusCode).toBe(200);
  });

  it("an operator adds a device only to a site they may operate; otherwise the site does not exist for them", async () => {
    const op = await member("op7", "admin");
    const mock = await env.startMock({ channels: 1 });
    const none = await addDevice(env, op, s1, mock);
    expect(none.statusCode).toBe(404);
    expect((none.json() as { code: string }).code).toBe("site_not_found");
    await grant(op.userId, "site", s1, "view");
    expect((await addDevice(env, op, s1, mock)).statusCode).toBe(403);
    await grant(op.userId, "site", s2, "operate");
    expect((await addDevice(env, op, s2, mock, { name: "Dari Operator" })).statusCode).toBe(201);
  });

  it("a site created by an operator is granted to them so they can see and use it; a viewer cannot create one", async () => {
    const op = await member("op8", "admin");
    const created = await call(op, "POST", "/v1/sites", { name: "Buatan Operator" });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as Item).id;
    expect(await ids(op, "/v1/sites")).toEqual([id]);
    const mine = (
      (await call(op, "GET", "/v1/grants")).json() as {
        items: { scope: string; scopeId: string; permission: string }[];
      }
    ).items;
    expect(mine).toContainEqual(
      expect.objectContaining({ scope: "site", scopeId: id, permission: "operate" }),
    );
    const audit = await env.admin.query(
      `select count(*)::int as n from audit_log where actor_id = $1 and action = 'grant.create'`,
      [op.userId],
    );
    expect(audit.rows[0].n).toBe(1);
    const vw = await member("vw8", "member");
    expect((await call(vw, "POST", "/v1/sites", { name: "x" })).statusCode).toBe(403);
    // the owner is not given a redundant grant
    const ownerSite = (await call(owner, "POST", "/v1/sites", { name: "Milik Pemilik" })).json() as Item;
    const og = await env.admin.query(`select count(*)::int as n from camera_grant where scope_id = $1`, [
      ownerSite.id,
    ]);
    expect(og.rows[0].n).toBe(0);
  });

  it("another tenant sees none of this, whatever its own grants say", async () => {
    expect(await ids(other, "/v1/sites")).toEqual([]);
    expect(await ids(other, "/v1/devices")).toEqual([]);
    expect(await ids(other, "/v1/cameras")).toEqual([]);
    const bOp = await addMemberWithRole(env, other, "inv-bop", "admin");
    expect((await call(bOp, "GET", `/v1/devices/${d1}`)).statusCode).toBe(404);
  });

  it("devices reported by an agent follow the same rule", async () => {
    const op = await member("op9", "admin");
    const key = `agent-dev-${Math.random().toString(36).slice(2, 8)}`;
    const agent = await env.admin.query(
      `insert into agent (id, organization_id, site_id, name, public_key, token_hash) values ($1,$2,$3,'a','k',$4) returning id`,
      [`agt_${key}`, owner.orgId, s1, `h${key}`],
    );
    await env.admin.query(
      `insert into device (id, organization_id, site_id, name, kind, adapter_id, host, port, agent_id, agent_device_key)
       values ($1,$2,$3,'Dari Agen','ipc','onvif-generic','192.168.1.9',80,$4,'dev-x')`,
      [`dev_${key}`, owner.orgId, s1, agent.rows[0].id],
    );
    expect(await ids(op, "/v1/devices")).toEqual([]);
    await grant(op.userId, "site", s1, "view");
    expect(await ids(op, "/v1/devices")).toContain(`dev_${key}`);
  });
});

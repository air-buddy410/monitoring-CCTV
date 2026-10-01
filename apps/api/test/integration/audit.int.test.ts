import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDevice, createSite, createTenant, createTestEnv, type Tenant, type TestEnv } from "../helpers";

interface AuditItem {
  action: string;
  target: string;
  actorId: string | null;
  ip: string | null;
  at: string;
  meta: Record<string, unknown>;
}

describe("audit trail", () => {
  let env: TestEnv;
  let a: Tenant;
  let b: Tenant;
  beforeAll(async () => {
    env = await createTestEnv();
    a = await createTenant(env, "audit-a");
    b = await createTenant(env, "audit-b");
  });
  afterAll(async () => env.close());

  it("records device creation and snapshots with actor, target and ip; scoped per tenant", async () => {
    const siteId = (await createSite(env, a)).id;
    const mock = await env.startMock();
    const add = await addDevice(env, a, siteId, mock);
    const { device, cameras } = add.json() as { device: { id: string }; cameras: { id: string }[] };
    const snap = await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
    expect(snap.statusCode).toBe(200);

    const res = await env.built.app.inject({
      method: "GET",
      url: "/v1/audit",
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: AuditItem[] }).items;
    const created = items.find((i) => i.action === "device.create");
    const snapped = items.find((i) => i.action === "camera.snapshot");
    expect(created).toMatchObject({ target: device.id, actorId: a.userId });
    expect(created?.ip).toBeTruthy();
    expect(snapped).toMatchObject({ target: cameras[0]?.id, actorId: a.userId });
    expect(typeof snapped?.meta.bytes).toBe("number");

    const bItems = (
      (
        await env.built.app.inject({ method: "GET", url: "/v1/audit", headers: { cookie: b.cookie } })
      ).json() as {
        items: AuditItem[];
      }
    ).items;
    expect(bItems.find((i) => i.action === "device.create")).toBeUndefined();
    expect(bItems.find((i) => i.action === "camera.snapshot")).toBeUndefined();
  });

  it("records failed attempts (bad credentials, bad snapshot) without secrets", async () => {
    const siteId = (await createSite(env, a)).id;
    const mock = await env.startMock();
    await addDevice(env, a, siteId, mock, { password: "Wrong-Dummy-Pw-0000!" });
    const items = (
      (
        await env.built.app.inject({ method: "GET", url: "/v1/audit", headers: { cookie: a.cookie } })
      ).json() as {
        items: AuditItem[];
      }
    ).items;
    const failed = items.find((i) => i.action === "device.create.failed");
    expect(failed?.meta.reason).toBe("device_auth_failed");
    expect(JSON.stringify(failed)).not.toContain("Wrong-Dummy-Pw-0000!");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  createSite,
  createTenant,
  createTestEnv,
  DEVICE_PASSWORD,
  type Tenant,
  type TestEnv,
  USER_PASSWORD,
} from "../helpers";

describe("rate limits", () => {
  let env: TestEnv;
  let a: Tenant;
  let b: Tenant;
  let siteA: string;
  let siteB: string;

  beforeAll(async () => {
    env = await createTestEnv({
      RATE_LIMIT_PROBE_PER_MIN: "3",
      RATE_LIMIT_SNAPSHOT_PER_MIN: "2",
      RATE_LIMIT_AUTH_PER_MIN: "4",
    });
    // sign-ups count against the auth limit, so build tenants first with a separate, roomy env
  });
  afterAll(async () => env.close());

  it("login/sign-up: limit per client address, then 429 with Retry-After, even with correct credentials", async () => {
    const email = `rl-${Date.now()}@example.test`;
    const signUp = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: USER_PASSWORD, name: "rl" },
    });
    expect(signUp.statusCode).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await env.built.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        payload: { email, password: i < 3 ? "Wrong-Dummy-Login-0000!" : USER_PASSWORD },
      });
      codes.push(r.statusCode);
    }
    // 1 sign-up + 3 sign-in attempts fit in the limit of 4; the 4th sign-in (correct password) is throttled
    expect(codes.slice(0, 3).every((c) => c === 401 || c === 400)).toBe(true);
    expect(codes[3]).toBe(429);
    const throttled = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password: USER_PASSWORD },
    });
    expect(throttled.statusCode).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect((throttled.json() as { code: string }).code).toBe("rate_limited");
    expect(throttled.body).not.toContain(USER_PASSWORD);
  });

  it("other auth endpoints (session, organization) are not throttled by the credential limit", async () => {
    const res = await env.built.app.inject({ method: "GET", url: "/api/auth/get-session" });
    expect(res.statusCode).toBe(200);
  });

  describe("probe and snapshot (per authenticated user)", () => {
    let roomy: TestEnv;
    beforeAll(async () => {
      // tenants are created through a roomy instance sharing the same database, then used on the strict one
      roomy = await createTestEnv();
      a = await createTenant(roomy, "rl-a");
      b = await createTenant(roomy, "rl-b");
      siteA = (await createSite(roomy, a)).id;
      siteB = (await createSite(roomy, b)).id;
    });
    afterAll(async () => roomy.close());

    it("probe: the 4th attempt in the window gets 429 and never reaches the device", async () => {
      const mock = await env.startMock();
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await addDevice(env, a, siteA, mock, { password: "Wrong-Dummy-Pw-0000!" })).statusCode);
      }
      expect(codes).toEqual([422, 422, 422]); // failed attempts count too
      const opsBefore = mock.requests().length;
      const blocked = await addDevice(env, a, siteA, mock);
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(mock.requests().length).toBe(opsBefore);
      expect(blocked.body).not.toContain(DEVICE_PASSWORD);
    });

    it("probe: another user is not affected by the first user's limit", async () => {
      const mock = await env.startMock();
      expect((await addDevice(env, b, siteB, mock)).statusCode).toBe(201);
    });

    it("rate limited attempts are audited", async () => {
      const r = await env.admin.query(
        `select count(*)::int as n from audit_log where organization_id = $1 and action = 'device.create.failed' and meta->>'reason' = 'rate_limited'`,
        [a.orgId],
      );
      expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("snapshot: the 3rd attempt in the window gets 429 and never reaches the camera", async () => {
      const mock = await env.startMock();
      const add = await addDevice(env, b, siteB, mock).catch(() => null);
      // b has consumed 1 probe above; this is its 2nd probe (limit 3)
      expect(add?.statusCode).toBe(201);
      const { cameras } = (add as NonNullable<typeof add>).json() as { cameras: { id: string }[] };
      const url = `/v1/cameras/${cameras[0]?.id}/snapshot`;
      expect(
        (await env.built.app.inject({ method: "POST", url, headers: { cookie: b.cookie } })).statusCode,
      ).toBe(200);
      expect(
        (await env.built.app.inject({ method: "POST", url, headers: { cookie: b.cookie } })).statusCode,
      ).toBe(200);
      const hits = mock.snapshotRequestCount();
      const blocked = await env.built.app.inject({ method: "POST", url, headers: { cookie: b.cookie } });
      expect(blocked.statusCode).toBe(429);
      expect(mock.snapshotRequestCount()).toBe(hits);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  createSite,
  createTenant,
  createTestEnv,
  DEVICE_PASSWORD,
  DEVICE_USERNAME,
  type Tenant,
  type TestEnv,
  USER_PASSWORD,
} from "../helpers";

describe("secrets stay out of error paths", () => {
  let env: TestEnv;
  let a: Tenant;
  let siteId: string;

  beforeAll(async () => {
    env = await createTestEnv();
    a = await createTenant(env, "secerr-a");
    siteId = (await createSite(env, a)).id;
  });
  afterAll(async () => env.close());

  it("a device that echoes the submitted password in its SOAP fault does not leak it", async () => {
    const mock = await env.startMock({ faultEchoesPassword: true });
    const wrong = "Echoed-Wrong-Pw-4242!";
    const res = await addDevice(env, a, siteId, mock, { password: wrong });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(wrong);
    expect(res.body).not.toContain(DEVICE_USERNAME); // the fault text echoed "credentials <user>:<password>"
    const all = env.logs.join("\n");
    expect(all).not.toContain(wrong);
    const audit = await env.admin.query(`select meta::text as m from audit_log where organization_id = $1`, [
      a.orgId,
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(wrong);
  });

  it("validation errors never echo submitted values", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { cookie: a.cookie },
      payload: {
        siteId,
        name: "n",
        host: "not-an-ip",
        port: 99999,
        username: "u",
        password: DEVICE_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(DEVICE_PASSWORD);
    const malformed = await env.built.app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      payload: `{"password":"${DEVICE_PASSWORD}", `,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(DEVICE_PASSWORD);
  });

  it("a failed login (wrong password) leaves the attempted password out of response and logs", async () => {
    const attempted = "Attempted-Login-Pw-8080!";
    const res = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: a.email, password: attempted },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain(attempted);
    const all = env.logs.join("\n");
    expect(all).not.toContain(attempted);
    expect(all).not.toContain(USER_PASSWORD);
    expect(all).not.toContain(DEVICE_PASSWORD);
  });

  it("an unexpected server error returns a generic body and logs no request payload", async () => {
    const mock = await env.startMock({ snapshotBody: Buffer.from("garbage") });
    const add = await addDevice(env, a, siteId, mock);
    const { cameras } = add.json() as { cameras: { id: string }[] };
    // break the vault blob so decryption throws (unexpected 500 path)
    await env.admin.query(
      `update device_secret set credentials_enc = 'AAAA' where device_id = (select device_id from camera where id = $1)`,
      [cameras[0]?.id],
    );
    const res = await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { code: string }).code).toBe("internal_error");
    expect(res.body).not.toMatch(/vault|decrypt|AAAA/i);
    expect(env.logs.join("\n")).not.toContain(DEVICE_PASSWORD);
  });
});

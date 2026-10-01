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

describe("device password never leaks", () => {
  let env: TestEnv;
  let a: Tenant;
  const responses: string[] = [];

  beforeAll(async () => {
    env = await createTestEnv();
    a = await createTenant(env, "secrets-a");
    const siteId = (await createSite(env, a)).id;
    const mock = await env.startMock({ channels: 2 });

    const add = await addDevice(env, a, siteId, mock);
    responses.push(add.body);
    const { device, cameras } = add.json() as { device: { id: string }; cameras: { id: string }[] };

    // failing paths too: wrong password, timeout, invalid body
    responses.push((await addDevice(env, a, siteId, mock, { password: "Wrong-Dummy-Pw-0000!" })).body);
    const hung = await env.startMock({ hangOperations: ["GetProfiles"] });
    responses.push((await addDevice(env, a, siteId, hung)).body);
    responses.push(
      (
        await env.built.app.inject({
          method: "POST",
          url: "/v1/devices",
          headers: { cookie: a.cookie },
          payload: { siteId, host: "not an ip", port: 1, username: "u", password: DEVICE_PASSWORD },
        })
      ).body,
    );

    for (const url of [
      "/v1/devices",
      `/v1/devices/${device.id}`,
      "/v1/cameras",
      `/v1/cameras/${cameras[0]?.id}`,
      "/v1/audit",
      "/docs/json",
    ]) {
      responses.push(
        (await env.built.app.inject({ method: "GET", url, headers: { cookie: a.cookie } })).body,
      );
    }
    const snap = await env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameras[0]?.id}/snapshot`,
      headers: { cookie: a.cookie },
    });
    expect(snap.statusCode).toBe(200);
  });
  afterAll(async () => env.close());

  it("is absent from every API response (success and failure paths)", () => {
    expect(responses.length).toBeGreaterThan(8);
    for (const r of responses) {
      expect(r).not.toContain(DEVICE_PASSWORD);
      // the OpenAPI document legitimately names the *input* field; every other response must not
      if (!r.startsWith('{"openapi"')) expect(r.toLowerCase()).not.toContain('"password"');
    }
  });

  it("no OpenAPI response schema exposes a credential field", async () => {
    const doc = (await env.built.app.inject({ method: "GET", url: "/docs/json" })).json() as {
      paths: Record<string, Record<string, { responses?: unknown }>>;
    };
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const text = JSON.stringify(op.responses ?? {}).toLowerCase();
        expect(text, `${method} ${path}`).not.toMatch(/"(password|username|credentials?)"/);
      }
    }
  });

  it("is absent from all application logs, including debug level and the user's login password", () => {
    expect(env.logs.length).toBeGreaterThan(0);
    const all = env.logs.join("\n");
    expect(all).not.toContain(DEVICE_PASSWORD);
    expect(all).not.toContain(USER_PASSWORD);
  });

  it("is absent from every row of every table (stored only as AES-GCM ciphertext)", async () => {
    // Version-independent replacement for pg_dump (which refuses servers newer than the client).
    const tables = await env.admin.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    expect(tables.rows.map((t) => t.table_name)).toContain("device_secret");
    let dump = "";
    const counts: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const rows = await env.admin.query<{ r: string }>(`select t::text as r from "${table_name}" t`);
      counts[table_name] = rows.rowCount ?? 0;
      dump += rows.rows.map((x) => x.r).join("\n");
    }
    expect(counts.device_secret).toBeGreaterThan(0);
    expect(counts.audit_log).toBeGreaterThan(0);
    expect(dump).not.toContain(DEVICE_PASSWORD);
    expect(dump).not.toContain(USER_PASSWORD);
    // the base64 of the password must not be there either
    expect(dump).not.toContain(Buffer.from(DEVICE_PASSWORD).toString("base64"));
  });

  it("device and camera tables have no credential columns", async () => {
    const r = await env.admin.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name in ('device','camera','site','audit_log')
         and column_name ~* '(pass|secret|credential|token)'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("is absent from the audit trail", async () => {
    const r = await env.admin.query(`select meta::text as m, action, target from audit_log`);
    expect(r.rowCount).toBeGreaterThan(0);
    expect(JSON.stringify(r.rows)).not.toContain(DEVICE_PASSWORD);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDevice,
  createSite,
  createTenant,
  createTestEnv,
  ORIGIN,
  type Tenant,
  type TestEnv,
  totpFromUri,
  USER_PASSWORD,
} from "../helpers";

const jar = (setCookie: string | string[] | undefined, prev = ""): string => {
  const map = new Map<string, string>();
  for (const part of prev.split("; ").filter(Boolean)) map.set(part.split("=")[0] as string, part);
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of arr) {
    const pair = (c.split(";")[0] as string).trim();
    const [name, value] = [pair.split("=")[0] as string, pair.slice(pair.indexOf("=") + 1)];
    if (value === "" || /max-age=0/i.test(c)) map.delete(name);
    else map.set(name, pair);
  }
  return [...map.values()].join("; ");
};

describe("two-factor authentication (TOTP + backup codes)", () => {
  let env: TestEnv;
  const post = (url: string, cookie: string, payload?: unknown) =>
    env.built.app.inject({
      method: "POST",
      url,
      headers: { cookie, origin: ORIGIN },
      payload: payload as never,
    });

  /** Enable and confirm TOTP for a fresh tenant user; returns what an authenticator app and the user would hold. */
  async function enrolled(label: string): Promise<{ t: Tenant; uri: string; backup: string[] }> {
    const t = await createTenant(env, label);
    const en = await post("/api/auth/two-factor/enable", t.cookie, { password: USER_PASSWORD });
    expect(en.statusCode).toBe(200);
    const body = en.json() as { totpURI: string; backupCodes: string[] };
    const ver = await post("/api/auth/two-factor/verify-totp", t.cookie, { code: totpFromUri(body.totpURI) });
    expect(ver.statusCode).toBe(200);
    return {
      t: { ...t, cookie: jar(ver.headers["set-cookie"], t.cookie) },
      uri: body.totpURI,
      backup: body.backupCodes,
    };
  }

  async function signIn(
    email: string,
  ): Promise<{ cookie: string; body: Record<string, unknown>; status: number }> {
    const res = await post("/api/auth/sign-in/email", "", { email, password: USER_PASSWORD });
    return {
      cookie: jar(res.headers["set-cookie"]),
      body: res.json() as Record<string, unknown>,
      status: res.statusCode,
    };
  }

  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => env.close());

  it("enable needs the password and returns a TOTP URI plus backup codes; 2FA is not active until a code is verified", async () => {
    const t = await createTenant(env, "tf-enable");
    expect(
      (await post("/api/auth/two-factor/enable", t.cookie, { password: "wrong-wrong-wrong" })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    const en = await post("/api/auth/two-factor/enable", t.cookie, { password: USER_PASSWORD });
    expect(en.statusCode).toBe(200);
    const body = en.json() as { totpURI: string; backupCodes: string[] };
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(body.backupCodes.length).toBeGreaterThanOrEqual(8);
    const flag = await env.admin.query(`select two_factor_enabled from "user" where id = $1`, [t.userId]);
    expect(flag.rows[0].two_factor_enabled).toBe(false);
    // a pending enrolment does not lock the user out: password sign-in still gives a session
    const si = await signIn(t.email);
    expect(si.body.twoFactorRedirect).toBeUndefined();
    const orgs = await env.built.app.inject({
      method: "GET",
      url: "/api/auth/organization/list",
      headers: { cookie: si.cookie },
    });
    await post("/api/auth/organization/set-active", si.cookie, {
      organizationId: (orgs.json() as { id: string }[])[0]?.id,
    });
    expect(
      (await env.built.app.inject({ method: "GET", url: "/v1/sites", headers: { cookie: si.cookie } }))
        .statusCode,
    ).toBe(200);
  });

  it("a wrong confirmation code leaves 2FA disabled", async () => {
    const t = await createTenant(env, "tf-wrongconfirm");
    const en = await post("/api/auth/two-factor/enable", t.cookie, { password: USER_PASSWORD });
    const uri = (en.json() as { totpURI: string }).totpURI;
    const good = totpFromUri(uri);
    const bad = good === "000000" ? "111111" : "000000";
    expect((await post("/api/auth/two-factor/verify-totp", t.cookie, { code: bad })).statusCode).toBe(401);
    const flag = await env.admin.query(`select two_factor_enabled from "user" where id = $1`, [t.userId]);
    expect(flag.rows[0].two_factor_enabled).toBe(false);
  });

  it("after enrolment, password sign-in alone gives no session: it demands the second factor", async () => {
    const { t } = await enrolled("tf-challenge");
    const si = await signIn(t.email);
    expect(si.status).toBe(200);
    expect(si.body).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(JSON.stringify(si.body)).not.toMatch(/"token"/);
    expect(si.cookie).not.toMatch(/session_token/);
    for (const url of ["/v1/sites", "/v1/devices", "/v1/audit"]) {
      const res = await env.built.app.inject({ method: "GET", url, headers: { cookie: si.cookie } });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("a valid TOTP completes the sign-in and the new session reaches /v1", async () => {
    const { t, uri } = await enrolled("tf-login");
    const si = await signIn(t.email);
    const ver = await post("/api/auth/two-factor/verify-totp", si.cookie, { code: totpFromUri(uri) });
    expect(ver.statusCode).toBe(200);
    const cookie = jar(ver.headers["set-cookie"], si.cookie);
    expect(cookie).toMatch(/session_token/);
    // the fresh login has no active organization yet; activating one is a normal follow-up
    const orgs = await env.built.app.inject({
      method: "GET",
      url: "/api/auth/organization/list",
      headers: { cookie },
    });
    const orgId = (orgs.json() as { id: string }[])[0]?.id;
    await post("/api/auth/organization/set-active", cookie, { organizationId: orgId });
    expect(
      (await env.built.app.inject({ method: "GET", url: "/v1/sites", headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it("a wrong code is refused and creates no session; the challenge is not usable without its cookie", async () => {
    const { t, uri } = await enrolled("tf-wrong");
    const si = await signIn(t.email);
    const good = totpFromUri(uri);
    const bad = good === "123456" ? "654321" : "123456";
    const res = await post("/api/auth/two-factor/verify-totp", si.cookie, { code: bad });
    expect(res.statusCode).toBe(401);
    expect(jar(res.headers["set-cookie"], si.cookie)).not.toMatch(/session_token/);
    const noCookie = await post("/api/auth/two-factor/verify-totp", "", { code: good });
    expect(noCookie.statusCode).toBe(401);
  });

  it("backup codes work exactly once", async () => {
    const { t, backup } = await enrolled("tf-backup");
    const code = backup[0] as string;
    const first = await signIn(t.email);
    const ok = await post("/api/auth/two-factor/verify-backup-code", first.cookie, { code });
    expect(ok.statusCode).toBe(200);
    expect(jar(ok.headers["set-cookie"], first.cookie)).toMatch(/session_token/);
    const second = await signIn(t.email);
    const reuse = await post("/api/auth/two-factor/verify-backup-code", second.cookie, { code });
    expect(reuse.statusCode).toBeGreaterThanOrEqual(400);
    expect(jar(reuse.headers["set-cookie"], second.cookie)).not.toMatch(/session_token/);
    const other = await post("/api/auth/two-factor/verify-backup-code", second.cookie, { code: backup[1] });
    expect(other.statusCode).toBe(200);
  });

  it("the TOTP secret and backup codes are not stored in plaintext", async () => {
    const { t, uri, backup } = await enrolled("tf-storage");
    const row = await env.admin.query(`select secret, backup_codes from two_factor where user_id = $1`, [
      t.userId,
    ]);
    const stored = JSON.stringify(row.rows[0]);
    const b32 = new URL(uri).searchParams.get("secret") as string;
    expect(stored).not.toContain(b32);
    for (const c of backup) expect(stored).not.toContain(c);
    const dump = await env.admin.query(`select count(*)::int as n from two_factor where secret = $1`, [b32]);
    expect(dump.rows[0].n).toBe(0);
  });

  it("codes and URIs never reach the logs", async () => {
    const t = await createTenant(env, "tf-logs");
    const en = await post("/api/auth/two-factor/enable", t.cookie, { password: USER_PASSWORD });
    const { totpURI, backupCodes } = en.json() as { totpURI: string; backupCodes: string[] };
    const code = totpFromUri(totpURI);
    await post("/api/auth/two-factor/verify-totp", t.cookie, { code });
    const all = env.logs.join("\n");
    expect(all).not.toContain(new URL(totpURI).searchParams.get("secret") as string);
    expect(all).not.toContain(backupCodes[0] as string);
    expect(all).not.toContain(USER_PASSWORD);
  });

  it("disable needs the password and the next sign-in is password-only again", async () => {
    const { t } = await enrolled("tf-disable");
    expect(
      (await post("/api/auth/two-factor/disable", t.cookie, { password: "wrong-wrong-wrong" })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    const off = await post("/api/auth/two-factor/disable", t.cookie, { password: USER_PASSWORD });
    expect(off.statusCode).toBe(200);
    const si = await signIn(t.email);
    expect(si.body.twoFactorRedirect).toBeUndefined();
    expect(
      (await env.admin.query(`select count(*)::int as n from two_factor where user_id = $1`, [t.userId]))
        .rows[0].n,
    ).toBe(0);
  });

  it("a session cookie from before enrolment cannot be turned into a verified 2FA state by another user's code", async () => {
    const a = await enrolled("tf-a");
    const b = await enrolled("tf-b");
    const si = await signIn(a.t.email);
    const res = await post("/api/auth/two-factor/verify-totp", si.cookie, { code: totpFromUri(b.uri) });
    expect(res.statusCode).toBe(401);
  });

  describe("brute force", () => {
    it("the second-factor endpoints are throttled per client", async () => {
      const limited = await createTestEnv({ RATE_LIMIT_AUTH_PER_MIN: "6" });
      try {
        const out: number[] = [];
        for (let i = 0; i < 10; i++) {
          const r = await limited.built.app.inject({
            method: "POST",
            url: "/api/auth/two-factor/verify-totp",
            headers: { origin: ORIGIN, cookie: "" },
            payload: { code: "000000" },
            remoteAddress: "10.9.9.9",
          });
          out.push(r.statusCode);
        }
        expect(out.slice(0, 6).every((s) => s !== 429)).toBe(true);
        expect(out.slice(6).every((s) => s === 429)).toBe(true);
      } finally {
        await limited.close();
      }
    });

    it("too many wrong codes invalidate the challenge, so the right code no longer works", async () => {
      const { t, uri } = await enrolled("tf-brute");
      const si = await signIn(t.email);
      const good = totpFromUri(uri);
      const bad = good === "123456" ? "654321" : "123456";
      let last = 0;
      for (let i = 0; i < 12; i++)
        last = (await post("/api/auth/two-factor/verify-totp", si.cookie, { code: bad })).statusCode;
      expect(last).toBeGreaterThanOrEqual(400);
      const late = await post("/api/auth/two-factor/verify-totp", si.cookie, { code: good });
      expect(late.statusCode).toBeGreaterThanOrEqual(400);
      expect(jar(late.headers["set-cookie"], si.cookie)).not.toMatch(/session_token/);
    });
  });

  describe("2FA required for video (PRD section 11)", () => {
    it("with REQUIRE_2FA_FOR_VIDEO on, a snapshot is refused until the user has 2FA", async () => {
      const strict = await createTestEnv({ REQUIRE_2FA_FOR_VIDEO: "true" });
      try {
        const post2 = (url: string, cookie: string, payload?: unknown) =>
          strict.built.app.inject({
            method: "POST",
            url,
            headers: { cookie, origin: ORIGIN },
            payload: payload as never,
          });
        const t = await createTenant(strict, "tf-req");
        const site = await createSite(strict, t);
        const mock = await strict.startMock({ channels: 1 });
        const cam = ((await addDevice(strict, t, site.id, mock)).json() as { cameras: { id: string }[] })
          .cameras[0]?.id;
        const denied = await post2(`/v1/cameras/${cam}/snapshot`, t.cookie);
        expect(denied.statusCode).toBe(403);
        expect((denied.json() as { code: string }).code).toBe("two_factor_required");
        expect(mock.snapshotRequestCount()).toBe(0);
        const en = await post2("/api/auth/two-factor/enable", t.cookie, { password: USER_PASSWORD });
        const uri = (en.json() as { totpURI: string }).totpURI;
        const ver = await post2("/api/auth/two-factor/verify-totp", t.cookie, { code: totpFromUri(uri) });
        const cookie = jar(ver.headers["set-cookie"], t.cookie);
        expect((await post2(`/v1/cameras/${cam}/snapshot`, cookie)).statusCode).toBe(200);
      } finally {
        await strict.close();
      }
    });

    it("the default is off outside production and on in production", async () => {
      const { loadConfig } = await import("../../src/config");
      const base = {
        DATABASE_URL: "postgresql://x:y@127.0.0.1/z",
        BASE_URL: "http://localhost:3000",
        AUTH_SECRET: randomUUID() + randomUUID(),
        VAULT_KEY: Buffer.alloc(32, 1).toString("base64"),
      };
      expect(loadConfig({ ...base, NODE_ENV: "development" }).require2faForVideo).toBe(false);
      expect(loadConfig({ ...base, NODE_ENV: "production" }).require2faForVideo).toBe(true);
      expect(
        loadConfig({ ...base, NODE_ENV: "production", REQUIRE_2FA_FOR_VIDEO: "false" }).require2faForVideo,
      ).toBe(false);
    });
  });
});

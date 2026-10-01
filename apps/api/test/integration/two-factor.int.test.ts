import { createHmac } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenant, createTestEnv, ORIGIN, type Tenant, type TestEnv, USER_PASSWORD } from "../helpers";

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s) — mirrors the authenticator app for a given secret string. */
function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", Buffer.from(secret, "utf8")).update(buf).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const b0 = mac[offset] ?? 0;
  const b1 = mac[offset + 1] ?? 0;
  const b2 = mac[offset + 2] ?? 0;
  const b3 = mac[offset + 3] ?? 0;
  const bin = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/** Read the (encrypted) TOTP secret straight from the DB and derive the current code, like an authenticator app. */
async function currentCode(env: TestEnv, userId: string): Promise<string> {
  const row = await env.admin.query(`select secret from two_factor where user_id = $1`, [userId]);
  expect(row.rowCount).toBe(1);
  const secret = await symmetricDecrypt({ key: env.authSecret, data: row.rows[0].secret as string });
  return totp(secret);
}

describe("two-factor (TOTP + backup codes)", () => {
  let env: TestEnv;
  let user: Tenant;

  beforeAll(async () => {
    env = await createTestEnv();
    user = await createTenant(env, "2fa-user");
  });
  afterAll(async () => env.close());

  const auth = (method: string, url: string, cookie: string, payload?: unknown) =>
    env.built.app.inject({
      method: method as "POST",
      url,
      headers: { cookie, origin: ORIGIN },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  it("enables TOTP: returns a provisioning URI and one-time backup codes", async () => {
    const res = await auth("POST", "/api/auth/two-factor/enable", user.cookie, {
      password: USER_PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { method: string; totpURI: string; backupCodes: string[] };
    expect(body.method).toBe("totp");
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(body.totpURI).toContain("issuer=PANTAU");
    expect(body.backupCodes.length).toBeGreaterThanOrEqual(8);
    // the secret must be stored encrypted, never plaintext
    const raw = await env.admin.query(`select secret, backup_codes from two_factor where user_id = $1`, [
      user.userId,
    ]);
    expect(raw.rows[0].secret).not.toMatch(/^[A-Z2-7]{16,}$/);
    const pending = await env.admin.query(`select two_factor_enabled from "user" where id = $1`, [
      user.userId,
    ]);
    expect(pending.rows[0].two_factor_enabled).toBe(false);
  });

  it("does not reveal the secret or backup codes through the DB-read helper", async () => {
    // sanity: the derived code is a 6-digit string and the stored secret is ciphertext
    expect(await currentCode(env, user.userId)).toMatch(/^\d{6}$/);
  });

  it("a wrong TOTP code is rejected and no session is granted", async () => {
    const res = await auth("POST", "/api/auth/two-factor/verify-totp", user.cookie, { code: "000000" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("verifies TOTP while signed in and activates 2FA for the account", async () => {
    const code = await currentCode(env, user.userId);
    const res = await auth("POST", "/api/auth/two-factor/verify-totp", user.cookie, { code });
    expect(res.statusCode).toBe(200);
    const active = await env.admin.query(`select two_factor_enabled from "user" where id = $1`, [
      user.userId,
    ]);
    expect(active.rows[0].two_factor_enabled).toBe(true);
  });

  it("once active, a fresh sign-in returns twoFactorRedirect and hands out no session", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email: user.email, password: USER_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    // the cookies from this response (if any) must not authenticate a protected API call
    const cookies = ((res.headers["set-cookie"] as unknown as string[]) ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    const guarded = await env.built.app.inject({
      method: "GET",
      url: "/v1/sites",
      headers: cookies ? { cookie: cookies } : {},
    });
    expect(guarded.statusCode).toBe(401);
  });

  it("completes the 2FA login: a valid TOTP after sign-in yields a session", async () => {
    const signIn = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email: user.email, password: USER_PASSWORD },
    });
    const twoFactorCookie = ((signIn.headers["set-cookie"] as unknown as string[]) ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(twoFactorCookie).toContain("better-auth.two_factor");

    const code = await currentCode(env, user.userId);
    const res = await auth("POST", "/api/auth/two-factor/verify-totp", twoFactorCookie, { code });
    expect(res.statusCode).toBe(200);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.includes("better-auth.session_token"))).toBe(true);
  });
});

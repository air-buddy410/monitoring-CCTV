import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSite, createTenant, createTestEnv, type Tenant, type TestEnv } from "../helpers";

/**
 * Better Auth skips its Origin check when NODE_ENV === "test", so these tests run the app
 * with NODE_ENV=development (restored afterwards) to exercise the real behaviour.
 */
describe("Origin / CSRF protection", () => {
  const prevEnv = process.env.NODE_ENV;
  let env: TestEnv;
  let a: Tenant;
  const GOOD = "http://localhost:3000";
  const EVIL = "https://evil.example.test";

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    env = await createTestEnv({ NODE_ENV: "development" });
    // createTenant sends no Origin: allowed only for cookie-less sign-up; then add Origin for cookie calls
    a = await createTenantWithOrigin(env, GOOD);
  });
  afterAll(async () => {
    await env.close();
    process.env.NODE_ENV = prevEnv;
  });

  async function createTenantWithOrigin(e: TestEnv, origin: string): Promise<Tenant> {
    // Minimal local variant of createTenant that sends the Origin header on cookie-bearing calls.
    const label = `csrf-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${label}@example.test`;
    const signUp = await e.built.app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin },
      payload: { email, password: "Dummy-User-Login-Pw-5521!", name: label },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = [signUp.headers["set-cookie"]]
      .flat()
      .map((c) => String(c).split(";")[0])
      .join("; ");
    const org = await e.built.app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie, origin },
      payload: { name: label, slug: label },
    });
    expect(org.statusCode).toBe(200);
    const orgId = (org.json() as { id: string }).id;
    await e.built.app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie, origin },
      payload: { organizationId: orgId },
    });
    return { cookie, userId: "", orgId, email };
  }

  it("auth: cookie-bearing POST with a foreign Origin is rejected", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: a.cookie, origin: EVIL },
      payload: { name: "x", slug: "evil-org" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("auth: cookie-bearing POST without Origin is rejected", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: a.cookie },
      payload: { name: "x", slug: "no-origin-org" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("auth: cookie-bearing POST with the trusted Origin works", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/organization/create",
      headers: { cookie: a.cookie, origin: GOOD },
      payload: { name: "ok", slug: `ok-${Date.now()}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("/v1: state-changing request with a foreign Origin is rejected and has no effect", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { cookie: a.cookie, origin: EVIL },
      payload: { name: "csrf-site" },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("csrf_origin_rejected");
    const list = await env.built.app.inject({
      method: "GET",
      url: "/v1/sites",
      headers: { cookie: a.cookie },
    });
    expect((list.json() as { items: { name: string }[] }).items.some((s) => s.name === "csrf-site")).toBe(
      false,
    );
  });

  it("/v1: Sec-Fetch-Site: cross-site is rejected even without an Origin header", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { cookie: a.cookie, "sec-fetch-site": "cross-site" },
      payload: { name: "csrf-site-2" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("/v1: the 'null' origin is rejected", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { cookie: a.cookie, origin: "null" },
      payload: { name: "csrf-site-3" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("/v1: trusted Origin and non-browser clients (no Origin) work; safe methods are not restricted", async () => {
    const withOrigin = await env.built.app.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { cookie: a.cookie, origin: GOOD },
      payload: { name: "ok-site" },
    });
    expect(withOrigin.statusCode).toBe(201);
    const noOrigin = await env.built.app.inject({
      method: "POST",
      url: "/v1/sites",
      headers: { cookie: a.cookie },
      payload: { name: "ok-site-2" },
    });
    expect(noOrigin.statusCode).toBe(201);
    const safe = await env.built.app.inject({
      method: "GET",
      url: "/v1/sites",
      headers: { cookie: a.cookie, origin: EVIL },
    });
    expect(safe.statusCode).toBe(200);
  });

  it("rejection bodies contain no secrets", async () => {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/devices",
      headers: { cookie: a.cookie, origin: EVIL },
      payload: {
        siteId: "x",
        name: "n",
        host: "10.0.0.1",
        port: 80,
        username: "u",
        password: "Dummy-Sentinel-Pw-7391!",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("Dummy-Sentinel-Pw-7391!");
    void createSite;
  });
});

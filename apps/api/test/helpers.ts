import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { type MockOnvif, type MockOnvifOptions, startMockOnvif } from "@pantau/mock-onvif";
import pg from "pg";
import { inject } from "vitest";
import { type BuiltApp, buildApp } from "../src/app";
import { loadConfig } from "../src/config";

/** Dummy sentinel; any appearance in responses/logs/DB dumps is a leak. */
export const DEVICE_PASSWORD = "Dummy-Sentinel-Pw-7391!";
export const DEVICE_USERNAME = "dummy-admin";
/** Matches BASE_URL below. Cookie-bearing auth calls need a trusted Origin (CSRF protection). */
export const ORIGIN = "http://localhost:3000";
export const USER_PASSWORD = "Dummy-User-Login-Pw-5521!";

export interface TestEnv {
  built: BuiltApp;
  /** Start a real HTTP listener on a free loopback port (needed for WebSocket tests). */
  listen(): Promise<{ httpUrl: string; wsUrl: string }>;
  logs: string[];
  mocks: MockOnvif[];
  close(): Promise<void>;
  startMock(opts?: Partial<MockOnvifOptions>): Promise<MockOnvif>;
  admin: pg.Pool;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const urls = inject("dbUrls");
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: urls.app,
    VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    AUTH_SECRET: "test-secret-test-secret-test-secret-123456",
    BASE_URL: "http://localhost:3000",
    ALLOW_LOOPBACK_TARGETS: "true",
    ONVIF_TIMEOUT_MS: "1500",
    SNAPSHOT_TIMEOUT_MS: "1500",
    LOG_LEVEL: "debug",
    // generous by default so ordinary tests are not throttled; rate-limit tests override these
    RATE_LIMIT_PROBE_PER_MIN: "1000",
    RATE_LIMIT_SNAPSHOT_PER_MIN: "1000",
    RATE_LIMIT_AUTH_PER_MIN: "1000",
    ...overrides,
  });
  const built = await buildApp({ config, logStream });
  await built.app.ready();
  const admin = new pg.Pool({ connectionString: urls.admin, max: 2 });
  const mocks: MockOnvif[] = [];
  return {
    built,
    logs,
    mocks,
    admin,
    async listen() {
      await built.app.listen({ port: 0, host: "127.0.0.1" });
      const addr = built.app.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      return { httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
    },
    async startMock(opts = {}) {
      const m = await startMockOnvif({
        username: DEVICE_USERNAME,
        password: DEVICE_PASSWORD,
        ...opts,
      });
      mocks.push(m);
      return m;
    },
    async close() {
      await built.close();
      await Promise.all(mocks.map((m) => m.stop()));
      await admin.end();
    },
  };
}

export interface Tenant {
  cookie: string;
  userId: string;
  orgId: string;
  email: string;
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return arr.map((c) => c.split(";")[0]).join("; ");
}

/** Sign up through Better Auth, then create an organization (= tenant) and make it active. */
export async function createTenant(env: TestEnv, label: string): Promise<Tenant> {
  const { app } = env.built;
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: USER_PASSWORD, name: `User ${label}` },
  });
  if (signUp.statusCode !== 200) throw new Error(`sign-up failed ${signUp.statusCode}: ${signUp.body}`);
  const userId = (signUp.json() as { user: { id: string } }).user.id;
  const cookie = cookieFrom(signUp.headers["set-cookie"]);
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie, origin: ORIGIN },
    payload: { name: `Org ${label}`, slug: `org-${label}-${randomUUID().slice(0, 8)}` },
  });
  if (org.statusCode !== 200) throw new Error(`org create failed ${org.statusCode}: ${org.body}`);
  const orgId = (org.json() as { id: string }).id;
  const setActive = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie, origin: ORIGIN },
    payload: { organizationId: orgId },
  });
  if (setActive.statusCode !== 200) throw new Error(`set-active failed ${setActive.statusCode}`);
  return { cookie, userId, orgId, email };
}

/** Add an existing org member with a given role (test-only shortcut via the admin connection). */
export async function addMemberWithRole(
  env: TestEnv,
  org: Tenant,
  label: string,
  role: "admin" | "member" | "noc",
): Promise<Tenant> {
  const other = await createTenant(env, label);
  await env.admin.query(
    `insert into "member" (id, organization_id, user_id, role, created_at) values ($1,$2,$3,$4, now())`,
    [randomUUID(), org.orgId, other.userId, role],
  );
  const setActive = await env.built.app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: other.cookie, origin: ORIGIN },
    payload: { organizationId: org.orgId },
  });
  if (setActive.statusCode !== 200) throw new Error(`set-active failed ${setActive.statusCode}`);
  return { ...other, orgId: org.orgId };
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from an otpauth URI, as an authenticator app would compute it. */
export function totpFromUri(uri: string, atMs = Date.now()): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac("sha1", bytes).update(counter).digest();
  const off = (h[h.length - 1] as number) & 0xf;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/** A fresh Ed25519 public key as an agent would send it (SPKI DER, base64). */
export function newAgentPublicKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
}
export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSite(env: TestEnv, t: Tenant, name = "Site Dummy") {
  const res = await env.built.app.inject({
    method: "POST",
    url: "/v1/sites",
    headers: { cookie: t.cookie },
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`site create failed ${res.statusCode}: ${res.body}`);
  return res.json() as { id: string };
}

/** Give a member access through the real API, as the tenant owner would. Default is deny for operator and viewer. */
export async function giveAccess(
  env: TestEnv,
  owner: Tenant,
  userId: string,
  scope: "site" | "camera",
  scopeId: string,
  permission: "view" | "operate",
): Promise<void> {
  const res = await env.built.app.inject({
    method: "POST",
    url: "/v1/grants",
    headers: { cookie: owner.cookie },
    payload: { userId, scope, scopeId, permission },
  });
  if (res.statusCode !== 201) throw new Error(`grant failed ${res.statusCode}: ${res.body}`);
}

export async function addDevice(
  env: TestEnv,
  t: Tenant,
  siteId: string,
  mock: MockOnvif,
  extra: Record<string, unknown> = {},
) {
  return env.built.app.inject({
    method: "POST",
    url: "/v1/devices",
    headers: { cookie: t.cookie },
    payload: {
      siteId,
      name: "Mock Device",
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
      ...extra,
    },
  });
}

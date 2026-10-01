import { createHmac, randomUUID } from "node:crypto";
import { loadDemoFrames, type MockOnvif, type MockOnvifOptions, startMockOnvif } from "@pantau/mock-onvif";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import pg from "pg";

export const WEB = "http://localhost:3100";
export const API = "http://localhost:3101";
export const USER_PASSWORD = "Dummy-User-Login-Pw-5521!";
export const DEVICE_USER = "dummy-admin";
export const DEVICE_PASSWORD = "Dummy-Sentinel-Pw-7391!";

const ADMIN = process.env.PANTAU_TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const adminUrl = (() => {
  const u = new URL(ADMIN);
  u.pathname = `/${process.env.PANTAU_E2E_DB ?? "pantau_e2e"}`;
  return u.toString();
})();

let pool: pg.Pool | null = null;
/** Superuser connection used only to arrange test state (membership rows, expiring sessions). */
export const db = () => {
  pool ??= new pg.Pool({ connectionString: adminUrl, max: 2 });
  return pool;
};
export const closeDb = async () => {
  await pool?.end();
  pool = null;
};

export interface Tenant {
  email: string;
  userId: string;
  orgId: string;
  cookie: { name: string; value: string };
}

const json = { "content-type": "application/json", origin: WEB };

function sessionCookie(res: Response): { name: string; value: string } {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  if (!raw) throw new Error("no session cookie in response");
  const [pair] = raw.split(";");
  const i = (pair as string).indexOf("=");
  return { name: (pair as string).slice(0, i), value: (pair as string).slice(i + 1) };
}
const cookieHeader = (c: { name: string; value: string }) => `${c.name}=${c.value}`;

/** Real sign-up through the backend API (not through the UI), used to arrange state quickly. */
export async function newUser(label: string): Promise<Omit<Tenant, "orgId">> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, password: USER_PASSWORD, name: `Pengguna ${label}` }),
  });
  if (!res.ok) throw new Error(`sign-up failed ${res.status}`);
  const body = (await res.json()) as { user: { id: string } };
  return { email, userId: body.user.id, cookie: sessionCookie(res) };
}

export async function newTenant(label: string): Promise<Tenant> {
  const u = await newUser(label);
  const org = await fetch(`${API}/api/auth/organization/create`, {
    method: "POST",
    headers: { ...json, cookie: cookieHeader(u.cookie) },
    body: JSON.stringify({ name: `Organisasi ${label}`, slug: `org-${label}-${randomUUID().slice(0, 6)}` }),
  });
  if (!org.ok) throw new Error(`org create failed ${org.status}`);
  const { id } = (await org.json()) as { id: string };
  await fetch(`${API}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { ...json, cookie: cookieHeader(u.cookie) },
    body: JSON.stringify({ organizationId: id }),
  });
  return { ...u, orgId: id };
}

/** A second user who is a member of `tenant`'s organization with the given Better Auth role. */
export async function newMember(
  tenant: Tenant,
  label: string,
  role: "admin" | "member" | "noc",
): Promise<Tenant> {
  const u = await newUser(label);
  await db().query(
    `insert into "member" (id, organization_id, user_id, role, created_at) values ($1,$2,$3,$4, now())`,
    [randomUUID(), tenant.orgId, u.userId, role],
  );
  await fetch(`${API}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { ...json, cookie: cookieHeader(u.cookie) },
    body: JSON.stringify({ organizationId: tenant.orgId }),
  });
  return { ...u, orgId: tenant.orgId };
}

export async function signInAs(context: BrowserContext, t: Tenant) {
  await context.addCookies([
    {
      name: t.cookie.name,
      value: t.cookie.value,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

export async function startMock(opts: Partial<MockOnvifOptions> = {}): Promise<MockOnvif> {
  const frames = loadDemoFrames();
  return startMockOnvif({
    username: DEVICE_USER,
    password: DEVICE_PASSWORD,
    manufacturer: "MockVendor",
    model: "MV-NVR-2",
    firmware: "9.9.9-mock",
    channels: 2,
    ptzChannels: [0],
    snapshotFrames: [frames[0] as Buffer, frames[1] as Buffer],
    ...opts,
  });
}

/** Add a site and a device through the real API (arranging state; the UI path is covered separately). */
export async function seedDevice(t: Tenant, mock: MockOnvif, name = "Perangkat Uji") {
  const headers = { ...json, cookie: cookieHeader(t.cookie) };
  const site = (await (
    await fetch(`${API}/v1/sites`, { method: "POST", headers, body: JSON.stringify({ name: "Lokasi Uji" }) })
  ).json()) as {
    id: string;
  };
  const res = await fetch(`${API}/v1/devices`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      siteId: site.id,
      name,
      host: mock.host,
      port: mock.port,
      username: DEVICE_USER,
      password: DEVICE_PASSWORD,
    }),
  });
  if (res.status !== 201) throw new Error(`seed device failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as { device: { id: string }; cameras: { id: string; name: string }[] };
}

export interface Watch {
  consoleErrors: string[];
  urls: string[];
}

/**
 * Collects console errors and every request URL. Browser-logged "Failed to load resource" lines for
 * statuses the test deliberately provokes are allowed; anything else counts as a console error.
 */
export function watch(page: Page, allowStatuses: number[] = []): Watch {
  const w: Watch = { consoleErrors: [], urls: [] };
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    const status = /status of (\d{3})/.exec(t)?.[1];
    if (status && allowStatuses.includes(Number(status))) return;
    w.consoleErrors.push(t);
  });
  page.on("pageerror", (e) => w.consoleErrors.push(`pageerror: ${e.message}`));
  page.on("request", (r) => w.urls.push(r.url()));
  return w;
}

export async function noLeaks(page: Page, w: Watch, secrets: string[]) {
  const html = await page.content();
  const storage = await page.evaluate(() =>
    JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }),
  );
  for (const s of secrets) {
    // booleans on purpose: a failing expect must not print the whole page
    expect(html.includes(s), "page HTML contains a secret").toBe(false);
    expect(storage.includes(s), "web storage contains a secret").toBe(false);
    expect(
      w.urls.some((u) => decodeURIComponent(u).includes(s)),
      "a request URL contains a secret",
    ).toBe(false);
    expect(w.consoleErrors.join("\n").includes(s), "console contains a secret").toBe(false);
  }
  const keys = Object.keys(JSON.parse(storage).l);
  expect(
    keys.every((k) => k === "pantau-theme"),
    `localStorage keys ${keys}`,
  ).toBe(true);
  expect(Object.keys(JSON.parse(storage).s)).toEqual([]);
}

export async function loginUi(page: Page, email: string, password = USER_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk", exact: true }).click();
}

/** A second organization for the same user (Better Auth makes the newly created one active). */
export async function addOrg(t: Tenant, name: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/organization/create`, {
    method: "POST",
    headers: { ...json, cookie: cookieHeader(t.cookie) },
    body: JSON.stringify({ name, slug: `org-${randomUUID().slice(0, 8)}` }),
  });
  if (!res.ok) throw new Error(`org create failed ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) from the base32 key an authenticator app is given. */
export function totpFromBase32(secret: string, atMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/[\s=]/g, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const off = (h[h.length - 1] as number) & 0xf;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** Arrange a grant through the real API as the tenant owner. */
export async function grantAccess(
  owner: Tenant,
  userId: string,
  scope: "site" | "camera",
  scopeId: string,
  permission: "view" | "operate",
) {
  const res = await fetch(`${API}/v1/grants`, {
    method: "POST",
    headers: { ...json, cookie: cookieHeader(owner.cookie) },
    body: JSON.stringify({ userId, scope, scopeId, permission }),
  });
  if (res.status !== 201) throw new Error(`grant failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string };
}

/** Turn on TOTP for a tenant's user through the real API (arranging state; the UI path is covered separately). */
export async function enableTotpViaApi(t: Tenant): Promise<{ secret: string; backup: string[] }> {
  const headers = { ...json, cookie: cookieHeader(t.cookie) };
  const en = await fetch(`${API}/api/auth/two-factor/enable`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password: USER_PASSWORD }),
  });
  if (!en.ok) throw new Error(`2fa enable failed ${en.status}`);
  const body = (await en.json()) as { totpURI: string; backupCodes: string[] };
  const secret = new URL(body.totpURI).searchParams.get("secret") as string;
  const ver = await fetch(`${API}/api/auth/two-factor/verify-totp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code: totpFromBase32(secret) }),
  });
  if (!ver.ok) throw new Error(`2fa verify failed ${ver.status}`);
  return { secret, backup: body.backupCodes };
}

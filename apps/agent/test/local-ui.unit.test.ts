import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onvifGenericAdapter } from "@pantau/adapters";
import { type MockOnvif, startMockOnvif } from "@pantau/mock-onvif";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/devices";
import { type LocalUi, startLocalUi } from "../src/local-ui";
import { FileVault } from "../src/vault";

const USER = "dummy-admin";
const PASS = "Dummy-Sentinel-Pw-7391!";
const PIN = "48151623";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(over: { discover?: () => Promise<never[] | object[]>; lockMs?: number } = {}) {
  const mock: MockOnvif = await startMockOnvif({ username: USER, password: PASS, channels: 2 });
  const dir = mkdtempSync(join(tmpdir(), "pantau-ui-"));
  const registry = new DeviceRegistry({
    dir,
    vault: FileVault.open(join(dir, "vault")),
    probe: (c) => onvifGenericAdapter.probe(c),
    allowLoopback: true,
    timeoutMs: 2000,
  });
  const ui: LocalUi = await startLocalUi({
    registry,
    pin: PIN,
    discover: (over.discover as never) ?? (async () => []),
    lockMs: over.lockMs ?? 60_000,
  });
  cleanups.push(
    () => ui.close(),
    () => mock.stop(),
  );
  return { mock, dir, registry, ui };
}

class Client {
  cookie = "";
  csrf = "";
  constructor(readonly base: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const url = new URL(path, this.base);
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h["content-type"] ??= "application/json";
    const res = await fetch(url, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const set = res.headers.getSetCookie()[0];
    if (set) this.cookie = set.split(";")[0] as string;
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: () => JSON.parse(text) as Record<string, any>,
    };
  }
  /** A same-origin write with the CSRF header, as the page itself sends it. */
  write(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    return this.req(method, path, body, {
      origin: new URL(this.base).origin,
      "x-csrf-token": this.csrf,
      ...extra,
    });
  }
  async login(pin = PIN) {
    const r = await this.req("POST", "/api/login", { pin }, { origin: new URL(this.base).origin });
    if (r.status === 200) this.csrf = r.json().csrf;
    return r;
  }
}

describe("local onboarding server: binding", () => {
  it("binds to 127.0.0.1 by default", async () => {
    const { ui } = await setup();
    expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
  it.each(["0.0.0.0", "::", "example.com", "8.8.8.8"])("refuses to bind %s", async (bindHost) => {
    const { registry } = await setup();
    await expect(startLocalUi({ registry, pin: PIN, discover: async () => [], bindHost })).rejects.toThrow(
      /bind/,
    );
  });
  it("refuses a short or non-numeric pin", async () => {
    const { registry } = await setup();
    for (const pin of ["1234", "abcdefgh", ""])
      await expect(startLocalUi({ registry, pin, discover: async () => [] })).rejects.toThrow(/pin/);
  });
});

describe("local onboarding server: access control", () => {
  it("serves the page with strict headers and no inline credential field value", async () => {
    const { ui } = await setup();
    const r = await new Client(ui.url).req("GET", "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.text).not.toContain(PIN);
    expect(r.text).not.toMatch(/—|–/);
  });
  it("rejects every API call without a session", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    expect((await c.req("GET", "/api/state")).status).toBe(401);
    expect((await c.write("POST", "/api/discover", {})).status).toBe(401);
    expect((await c.write("POST", "/api/devices", {})).status).toBe(401);
    expect((await c.write("DELETE", "/api/devices/dev-x")).status).toBe(401);
  });
  it("logs in with the pin, sets an HttpOnly SameSite=Strict cookie and never puts the pin in a url", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    const r = await c.login();
    expect(r.status).toBe(200);
    const raw = (
      await fetch(`${ui.url}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ui.url },
        body: JSON.stringify({ pin: PIN }),
      })
    ).headers.getSetCookie()[0] as string;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toContain("Path=/");
    expect(r.text).not.toContain(PIN);
    expect((await c.req("GET", "/api/state")).status).toBe(200);
    expect((await c.req("GET", `/api/state?pin=${PIN}`)).status).toBe(200);
  });
  it("rejects a wrong pin and locks out after five failures, even for the right pin", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    for (let i = 0; i < 5; i++) expect((await c.login("00000000")).status).toBe(401);
    const locked = await c.login(PIN);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
  });
  it("unlocks after the lock time", async () => {
    const { ui } = await setup({ lockMs: 150 });
    const c = new Client(ui.url);
    for (let i = 0; i < 5; i++) await c.login("00000000");
    expect((await c.login(PIN)).status).toBe(429);
    await new Promise((r) => setTimeout(r, 250));
    expect((await c.login(PIN)).status).toBe(200);
  });
  it("blocks DNS rebinding: a Host header that is not ours gets 421", async () => {
    const { ui } = await setup();
    const port = new URL(ui.url).port;
    const res = await fetch(`${ui.url}/`, { headers: { host: `evil.test:${port}` } }).catch(() => null);
    // fetch forbids overriding Host in some runtimes; fall back to a raw socket
    if (res && res.status !== 421) {
      const { request } = await import("node:http");
      const status = await new Promise<number>((resolve) => {
        const r = request(
          { host: "127.0.0.1", port: Number(port), path: "/", headers: { host: "evil.test" } },
          (x) => resolve(x.statusCode ?? 0),
        );
        r.end();
      });
      expect(status).toBe(421);
    } else if (res) expect(res.status).toBe(421);
  });
  it("rejects writes with a foreign or missing Origin", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    await c.login();
    expect((await c.req("POST", "/api/discover", {}, { "x-csrf-token": c.csrf })).status).toBe(403);
    expect(
      (await c.req("POST", "/api/discover", {}, { origin: "http://evil.test", "x-csrf-token": c.csrf }))
        .status,
    ).toBe(403);
    expect((await c.write("POST", "/api/discover", {})).status).toBe(200);
  });
  it("rejects writes without the CSRF token or with a wrong one", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    await c.login();
    const origin = new URL(ui.url).origin;
    expect((await c.req("POST", "/api/discover", {}, { origin })).status).toBe(403);
    expect((await c.req("POST", "/api/discover", {}, { origin, "x-csrf-token": "nope" })).status).toBe(403);
  });
  it("rejects a login from a foreign Origin", async () => {
    const { ui } = await setup();
    const r = await new Client(ui.url).req(
      "POST",
      "/api/login",
      { pin: PIN },
      { origin: "http://evil.test" },
    );
    expect(r.status).toBe(403);
  });
  it("rejects non-JSON writes and oversized bodies", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    await c.login();
    expect((await c.write("POST", "/api/discover", "x=1", { "content-type": "text/plain" })).status).toBe(
      415,
    );
    const big = JSON.stringify({ name: "x".repeat(20_000) });
    expect((await c.write("POST", "/api/devices", big)).status).toBe(413);
  });
  it("unknown routes are 404", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    await c.login();
    expect((await c.req("GET", "/api/nothing")).status).toBe(404);
    expect((await c.req("GET", "/../etc/passwd")).status).toBe(404);
  });
});

describe("local onboarding server: discovery and onboarding", () => {
  it("returns discovery candidates (Simulasi list)", async () => {
    const cand = [
      {
        host: "192.168.1.20",
        port: 80,
        xaddr: "http://192.168.1.20/onvif/device_service",
        endpointId: "urn:uuid:1",
      },
    ];
    const { ui } = await setup({ discover: async () => cand });
    const c = new Client(ui.url);
    await c.login();
    const r = await c.write("POST", "/api/discover", {});
    expect(r.status).toBe(200);
    expect(r.json().candidates).toEqual(cand);
  });
  it("adds a device: probes it, keeps the credential in the vault and never echoes it", async () => {
    const { ui, registry, dir, mock } = await setup();
    const c = new Client(ui.url);
    await c.login();
    const r = await c.write("POST", "/api/devices", {
      name: "NVR Simulasi",
      host: "127.0.0.1",
      port: mock.port,
      username: USER,
      password: PASS,
    });
    expect(r.status).toBe(201);
    expect(r.text).not.toContain(PASS);
    expect(r.text).not.toContain(USER);
    const dev = r.json().device;
    expect(dev.cameras).toHaveLength(2);
    expect(registry.credentialsFor(dev.deviceKey)).toEqual({ username: USER, password: PASS });
    const state = await c.req("GET", "/api/state");
    expect(state.text).not.toContain(PASS);
    expect(state.json().devices).toHaveLength(1);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")))
      expect(readFileSync(join(dir, f), "utf8")).not.toContain(PASS);
  });
  it("reports a wrong device password as a stable code without echoing it", async () => {
    const { ui, mock } = await setup();
    const c = new Client(ui.url);
    await c.login();
    const r = await c.write("POST", "/api/devices", {
      name: "NVR",
      host: "127.0.0.1",
      port: mock.port,
      username: USER,
      password: "Dummy-Wrong-Pw-1!",
    });
    expect(r.status).toBe(422);
    expect(r.json().code).toBe("device_auth_failed");
    expect(r.text).not.toContain("Dummy-Wrong-Pw-1!");
  });
  it("validates input and rejects extra fields", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    await c.login();
    expect((await c.write("POST", "/api/devices", { name: "x" })).status).toBe(400);
    const r = await c.write("POST", "/api/devices", {
      name: "x",
      host: "127.0.0.1",
      port: 80,
      username: "u",
      password: "p",
      extra: 1,
    });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('"p"');
  });
  it("rejects a target outside the policy", async () => {
    const { ui } = await setup();
    const c = new Client(ui.url);
    await c.login();
    const r = await c.write("POST", "/api/devices", {
      name: "meta",
      host: "169.254.169.254",
      port: 80,
      username: "u",
      password: "p",
    });
    expect(r.status).toBe(422);
    expect(r.json().code).toBe("target_not_allowed");
  });
  it("removes a device and its vault entry", async () => {
    const { ui, registry, mock } = await setup();
    const c = new Client(ui.url);
    await c.login();
    const add = await c.write("POST", "/api/devices", {
      name: "NVR",
      host: "127.0.0.1",
      port: mock.port,
      username: USER,
      password: PASS,
    });
    const key = add.json().device.deviceKey;
    expect((await c.write("DELETE", `/api/devices/${key}`)).status).toBe(204);
    expect(registry.list()).toHaveLength(0);
    expect(registry.credentialsFor(key)).toBeNull();
    expect((await c.write("DELETE", "/api/devices/dev-unknown")).status).toBe(404);
  });
  it("only one discovery runs at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { ui } = await setup({
      discover: async () => {
        await gate;
        return [];
      },
    });
    const c = new Client(ui.url);
    await c.login();
    const first = c.write("POST", "/api/discover", {});
    await new Promise((r) => setTimeout(r, 50));
    expect((await c.write("POST", "/api/discover", {})).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });
});

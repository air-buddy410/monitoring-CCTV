import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertLoopbackUrl, buildGo2rtcConfig, GO2RTC_LOOPBACK, Go2rtcClient } from "../src/go2rtc";

const SENTINEL = "Dummy-Sentinel-Pw-7391!";

// Simulasi: a stand-in for the go2rtc HTTP API, not the real binary.
function fakeGo2rtc() {
  const streams = new Map<string, string[]>();
  const seen: { method: string; url: string }[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    const name = u.searchParams.get("name");
    if (u.pathname === "/api/streams" && req.method === "PUT" && name) {
      streams.set(name, [...(streams.get(name) ?? []), u.searchParams.get("src") ?? ""]);
      res.writeHead(200).end();
    } else if (u.pathname === "/api/streams" && req.method === "DELETE" && name) {
      streams.delete(name);
      res.writeHead(200).end();
    } else if (u.pathname === "/api/streams" && req.method === "GET") {
      const body: Record<string, unknown> = {};
      for (const [k] of streams) body[k] = { producers: [{ url: "redacted" }] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    } else if (u.pathname === "/api/frame.jpeg" && u.searchParams.get("src") !== "missing") {
      res
        .writeHead(200, { "content-type": "image/jpeg" })
        .end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]));
    } else res.writeHead(404).end();
  });
  return { server, streams, seen };
}

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});
async function start() {
  const f = fakeGo2rtc();
  await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
  open.push(f.server);
  return { ...f, base: `http://127.0.0.1:${(f.server.address() as AddressInfo).port}` };
}

describe("buildGo2rtcConfig", () => {
  const cfg = buildGo2rtcConfig();
  it("binds every listener to loopback only", () => {
    expect(cfg).toContain(`listen: "${GO2RTC_LOOPBACK.api}"`);
    expect(cfg).toContain(`listen: "${GO2RTC_LOOPBACK.rtsp}"`);
    expect(cfg).toContain(`listen: "${GO2RTC_LOOPBACK.webrtc}"`);
    for (const m of cfg.matchAll(/listen:\s*"?([^"\n]+)"?/g)) expect(m[1]).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(cfg).not.toContain("0.0.0.0");
    expect(cfg).not.toMatch(/listen:\s*"?:\d+/);
  });
  it("turns on local_auth and keeps the config free of streams and secrets", () => {
    expect(cfg).toMatch(/local_auth:\s*true/);
    expect(cfg).not.toMatch(/rtsp:\/\/\S+@/);
    expect(cfg).not.toMatch(/username|password/i);
    expect(cfg).not.toContain("streams:");
  });
  it("does not enable origin wildcards or ngrok", () => {
    expect(cfg).not.toMatch(/origin:\s*"?\*/);
    expect(cfg).not.toContain("ngrok");
  });
});

describe("assertLoopbackUrl", () => {
  it("accepts http on 127.0.0.1 and ::1", () => {
    expect(() => assertLoopbackUrl("http://127.0.0.1:1984")).not.toThrow();
    expect(() => assertLoopbackUrl("http://[::1]:1984")).not.toThrow();
  });
  it.each([
    "http://0.0.0.0:1984",
    "http://192.168.1.5:1984",
    "http://localhost:1984",
    "https://127.0.0.1:1984",
    "http://127.0.0.1.evil.test:1984",
    "http://user:pw@127.0.0.1:1984",
    "http://8.8.8.8:1984",
    "not a url",
  ])("rejects %s", (u) => {
    expect(() => assertLoopbackUrl(u)).toThrow();
  });
});

describe("Go2rtcClient", () => {
  it("refuses a non-loopback base url at construction", () => {
    expect(() => new Go2rtcClient({ baseUrl: "http://192.168.1.5:1984" })).toThrow();
  });
  it("registers, lists and removes a stream through the local API", async () => {
    const s = await start();
    const c = new Go2rtcClient({ baseUrl: s.base });
    await c.putStream("cam1", `rtsp://admin:${SENTINEL}@127.0.0.1:554/s`);
    expect(s.streams.has("cam1")).toBe(true);
    expect(await c.listStreams()).toEqual(["cam1"]);
    await c.deleteStream("cam1");
    expect(await c.listStreams()).toEqual([]);
  });
  it("rejects bad stream names before any request", async () => {
    const s = await start();
    const c = new Go2rtcClient({ baseUrl: s.base });
    await expect(c.putStream("../x", "rtsp://127.0.0.1/s")).rejects.toThrow(/stream name/);
    await expect(c.putStream("a b", "rtsp://127.0.0.1/s")).rejects.toThrow(/stream name/);
    expect(s.seen).toEqual([]);
  });
  it("only forwards rtsp sources", async () => {
    const s = await start();
    const c = new Go2rtcClient({ baseUrl: s.base });
    await expect(c.putStream("cam1", "http://127.0.0.1/x")).rejects.toThrow(/source/);
    await expect(c.putStream("cam1", "exec:rm -rf /")).rejects.toThrow(/source/);
    await expect(c.putStream("cam1", "ffmpeg:x")).rejects.toThrow(/source/);
    expect(s.seen).toEqual([]);
  });
  it("never leaks the credential in an error message", async () => {
    const c = new Go2rtcClient({ baseUrl: "http://127.0.0.1:1" });
    const err = await c.putStream("cam1", `rtsp://admin:${SENTINEL}@127.0.0.1:554/s`).catch((e: Error) => e);
    expect(String(err)).not.toContain(SENTINEL);
    expect(String((err as Error).cause ?? "")).not.toContain(SENTINEL);
  });
  it("maps a non-2xx answer to a stable error without echoing the source", async () => {
    const s = await start();
    const c = new Go2rtcClient({ baseUrl: s.base });
    const err = await c.deleteStream("nope").then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeNull(); // delete is idempotent
    const bad = await c.frame("missing").catch((e: Error) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(String(bad)).not.toContain(SENTINEL);
  });
  it("fetches a JPEG frame", async () => {
    const s = await start();
    const c = new Go2rtcClient({ baseUrl: s.base });
    const jpeg = await c.frame("cam1");
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg.length).toBe(6);
  });
});

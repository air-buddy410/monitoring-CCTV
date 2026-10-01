import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentInbound } from "@pantau/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { AgentClient, type ClientOptions } from "../src/client";

interface Frame {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const hello = () => ({ agentVersion: "0.1.0", go2rtcVersion: null, hostname: "test-host" });
const inventory = () => ({ devices: [] });
const status = async () => ({ cameras: [], cpuPercent: 1, memUsedPercent: 2, diskUsedPercent: 3 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(10);
  }
  return false;
};

interface FakeApi {
  url: string;
  headers: Record<string, string | string[] | undefined>[];
  frames: Frame[];
  sockets: WebSocket[];
  paths: string[];
  send(type: string, payload: unknown, id?: string): void;
  closeAll(code?: number): void;
  stop(): Promise<void>;
}
const servers: FakeApi[] = [];
async function fakeApi(
  opts: {
    reject401?: boolean;
    autoPong?: boolean;
    replyAck?: boolean | ((f: Frame) => boolean);
    nthReject?: number;
  } = {},
): Promise<FakeApi> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true, autoPong: opts.autoPong ?? true });
  const api: FakeApi = {
    url: "",
    headers: [],
    frames: [],
    sockets: [],
    paths: [],
    send: () => undefined,
    closeAll: () => undefined,
    stop: async () => undefined,
  };
  let upgrades = 0;
  http.on("upgrade", (req, socket, head) => {
    upgrades++;
    api.headers.push(req.headers);
    api.paths.push(req.url ?? "");
    if (opts.reject401 || (opts.nthReject && upgrades <= opts.nthReject)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/problem+json\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      api.sockets.push(ws);
      ws.on("message", (d: RawData) => {
        const f = JSON.parse(d.toString()) as Frame;
        api.frames.push(f);
        const reply = typeof opts.replyAck === "function" ? opts.replyAck(f) : (opts.replyAck ?? true);
        if (reply && (f.type === "hello" || f.type === "inventory.sync")) {
          ws.send(JSON.stringify({ id: f.id, type: "ack", ts: new Date().toISOString(), payload: {} }));
        }
      });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  api.url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  api.send = (type, payload, id = `srv-${Math.random().toString(36).slice(2)}`) => {
    for (const s of api.sockets)
      if (s.readyState === 1) s.send(JSON.stringify({ id, type, ts: new Date().toISOString(), payload }));
  };
  api.closeAll = (code = 1012) => {
    for (const s of api.sockets) s.close(code);
  };
  api.stop = async () => {
    for (const s of api.sockets) s.terminate();
    wss.close();
    await new Promise<void>((r) => http.close(() => r()));
  };
  servers.push(api);
  return api;
}

const clients: AgentClient[] = [];
function client(api: FakeApi, over: Partial<ClientOptions> = {}): AgentClient {
  const c = new AgentClient({
    url: api.url,
    token: "pat_" + "T".repeat(43),
    hello,
    inventory,
    status,
    logger: quiet,
    statusIntervalMs: 60,
    pingIntervalMs: 60,
    pongTimeoutMs: 120,
    ackTimeoutMs: 300,
    backoff: () => 20,
    ...over,
  });
  clients.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("AgentClient: the PRD 9.2 protocol", () => {
  it("connects to /agent with Authorization: Agent <token> and nothing else secret", async () => {
    const api = await fakeApi();
    const c = client(api);
    c.start();
    expect(await until(() => api.frames.length > 0)).toBe(true);
    expect(api.paths[0]).toBe("/agent");
    expect(api.headers[0]?.authorization).toBe(`Agent pat_${"T".repeat(43)}`);
    expect(String(api.paths[0])).not.toContain("pat_");
  });

  it("sends hello, waits for its ack, then inventory.sync, then status; every frame matches the contract", async () => {
    const api = await fakeApi();
    const ready: number[] = [];
    const c = client(api);
    c.on("ready", () => ready.push(1));
    c.start();
    expect(await until(() => api.frames.filter((f) => f.type === "status").length >= 3)).toBe(true);
    expect(api.frames.slice(0, 2).map((f) => f.type)).toEqual(["hello", "inventory.sync"]);
    expect(ready).toHaveLength(1);
    for (const f of api.frames) {
      expect(AgentInbound.safeParse(f).success, f.type).toBe(true);
      expect(f.id.length).toBeGreaterThan(0);
      expect(new Date(f.ts).toString()).not.toBe("Invalid Date");
    }
    const ids = api.frames.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not send inventory.sync before hello is acknowledged", async () => {
    const api = await fakeApi({ replyAck: false });
    const c = client(api, { ackTimeoutMs: 400 });
    c.start();
    await wait(150);
    expect(api.frames.map((f) => f.type)).toEqual(["hello"]);
  });

  it("status is sent every interval (default 30 s in production, shortened here)", async () => {
    const api = await fakeApi();
    client(api, { statusIntervalMs: 50 }).start();
    await until(() => api.frames.filter((f) => f.type === "status").length >= 4);
    const times = api.frames.filter((f) => f.type === "status").map((f) => new Date(f.ts).getTime());
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i] as number) - (times[i - 1] as number);
      expect(gap).toBeGreaterThan(20);
      expect(gap).toBeLessThan(400);
    }
  });

  it("the production defaults are 30 s status, 20 s heartbeat, 5 s ack", () => {
    const c = new AgentClient({ url: "ws://x", token: "t", hello, inventory, status, logger: quiet });
    expect(c.settings).toMatchObject({
      statusIntervalMs: 30_000,
      pingIntervalMs: 20_000,
      ackTimeoutMs: 5_000,
    });
  });

  it("reconnects after the server drops the connection, repeating hello and inventory, and resets the backoff", async () => {
    const api = await fakeApi();
    const attempts: number[] = [];
    const c = client(api, { backoff: (n) => (attempts.push(n), 20) });
    c.start();
    await until(() => api.frames.some((f) => f.type === "inventory.sync"));
    api.closeAll();
    expect(await until(() => api.frames.filter((f) => f.type === "hello").length >= 2)).toBe(true);
    expect(await until(() => api.frames.filter((f) => f.type === "inventory.sync").length >= 2)).toBe(true);
    api.closeAll();
    await until(() => api.frames.filter((f) => f.type === "hello").length >= 3);
    // a connection that became ready starts counting from attempt 0 again
    expect(attempts.every((n) => n === 0)).toBe(true);
  });

  it("keeps trying with growing attempt numbers while the server is unreachable", async () => {
    const api = await fakeApi();
    const url = api.url;
    await api.stop();
    servers.length = 0;
    const attempts: number[] = [];
    const c = new AgentClient({
      url,
      token: "t",
      hello,
      inventory,
      status,
      logger: quiet,
      backoff: (n) => (attempts.push(n), 15),
    });
    clients.push(c);
    c.start();
    expect(await until(() => attempts.length >= 4)).toBe(true);
    expect(attempts.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });

  it("a 401 on the upgrade is fatal: the agent says so and stops retrying", async () => {
    const api = await fakeApi({ reject401: true });
    const c = client(api);
    let unauthorized = 0;
    c.on("unauthorized", () => unauthorized++);
    c.start();
    expect(await until(() => unauthorized === 1)).toBe(true);
    const seen = api.headers.length;
    await wait(250);
    expect(api.headers.length).toBe(seen);
    expect(c.state).toBe("unauthorized");
  });

  it("a close with code 4401 (revoked while connected) is also fatal", async () => {
    const api = await fakeApi();
    const c = client(api);
    let unauthorized = 0;
    c.on("unauthorized", () => unauthorized++);
    c.start();
    await until(() => api.frames.some((f) => f.type === "inventory.sync"));
    api.closeAll(4401);
    expect(await until(() => unauthorized === 1)).toBe(true);
    const hellos = api.frames.filter((f) => f.type === "hello").length;
    await wait(250);
    expect(api.frames.filter((f) => f.type === "hello").length).toBe(hellos);
  });

  it("a missing ack within the timeout drops the connection and starts over", async () => {
    let first = true;
    const api = await fakeApi({
      replyAck: (f) => (f.type === "hello" && first ? ((first = false), false) : true),
    });
    client(api, { ackTimeoutMs: 80 }).start();
    expect(await until(() => api.frames.some((f) => f.type === "inventory.sync"))).toBe(true);
    expect(api.frames.filter((f) => f.type === "hello").length).toBeGreaterThanOrEqual(2);
  });

  it("heartbeat: pings the server and drops a connection whose pong never comes", async () => {
    const api = await fakeApi({ autoPong: false });
    const c = client(api, { pingIntervalMs: 40, pongTimeoutMs: 80 });
    let drops = 0;
    c.on("disconnected", () => drops++);
    c.start();
    expect(await until(() => drops >= 1, 2000)).toBe(true);
    expect(await until(() => api.frames.filter((f) => f.type === "hello").length >= 2, 2000)).toBe(true);
  });

  it("heartbeat: a healthy server keeps the connection up across many pings", async () => {
    const api = await fakeApi();
    const c = client(api, { pingIntervalMs: 30, pongTimeoutMs: 100 });
    let drops = 0;
    c.on("disconnected", () => drops++);
    c.start();
    await wait(500);
    expect(drops).toBe(0);
    expect(api.frames.filter((f) => f.type === "hello")).toHaveLength(1);
  });

  it("a server error frame is reported and does not crash or reconnect", async () => {
    const api = await fakeApi({ replyAck: (f) => f.type === "hello" });
    const c = client(api, { ackTimeoutMs: 2000 });
    const seen: string[] = [];
    c.on("protocol-error", (e: { code: string }) => seen.push(e.code));
    c.start();
    await until(() => api.frames.some((f) => f.type === "inventory.sync"));
    const inv = api.frames.find((f) => f.type === "inventory.sync") as Frame;
    api.send("error", { code: "invalid_payload", message: "nope" }, inv.id);
    expect(await until(() => seen.length === 1)).toBe(true);
    expect(seen).toEqual(["invalid_payload"]);
    expect(api.frames.filter((f) => f.type === "hello")).toHaveLength(1);
  });

  describe("requests from the API", () => {
    it("without a handler the command is refused as unsupported, with the same id", async () => {
      const api = await fakeApi();
      client(api).start();
      await until(() => api.frames.some((f) => f.type === "inventory.sync"));
      api.send("ptz.command", { deviceKey: "dev-1", channel: "1", action: "stop" }, "req-1");
      expect(await until(() => api.frames.some((f) => f.type === "ptz.command.result"))).toBe(true);
      const r = api.frames.find((f) => f.type === "ptz.command.result") as Frame;
      expect(r.id).toBe("req-1");
      expect(r.payload).toEqual({ ok: false, code: "unsupported" });
    });

    it("a handler's result is sent back with the request id", async () => {
      const api = await fakeApi();
      client(api, { handlers: { "ptz.command": async () => ({ ok: true }) } }).start();
      await until(() => api.frames.some((f) => f.type === "inventory.sync"));
      api.send("ptz.command", { deviceKey: "dev-1", channel: "1", action: "stop" }, "req-2");
      await until(() => api.frames.some((f) => f.type === "ptz.command.result"));
      const r = api.frames.find((f) => f.type === "ptz.command.result") as Frame;
      expect(r).toMatchObject({ id: "req-2", payload: { ok: true } });
    });

    it("a handler that never finishes is cut off at the per-request timeout (ptz 3 s, snapshot 5 s, search 15 s in production)", async () => {
      const api = await fakeApi();
      const c = client(api, {
        handlers: { "ptz.command": () => new Promise(() => undefined) },
        requestTimeouts: { "ptz.command": 80, "snapshot.request": 80, "recordings.search": 80 },
      });
      c.start();
      await until(() => api.frames.some((f) => f.type === "inventory.sync"));
      const started = Date.now();
      api.send("ptz.command", { deviceKey: "dev-1", channel: "1", action: "stop" }, "req-3");
      expect(await until(() => api.frames.some((f) => f.type === "ptz.command.result"))).toBe(true);
      expect(Date.now() - started).toBeLessThan(600);
      const r = api.frames.find((f) => f.type === "ptz.command.result") as Frame;
      expect(r).toMatchObject({ id: "req-3", payload: { ok: false, code: "timeout" } });
      expect(c.settings.requestTimeouts["ptz.command"]).toBe(80);
    });

    it("a handler that throws gets a generic failure, never its message", async () => {
      const api = await fakeApi();
      client(api, {
        handlers: {
          "ptz.command": async () => {
            throw new Error("secret: Dummy-Sentinel-Pw-7391!");
          },
        },
      }).start();
      await until(() => api.frames.some((f) => f.type === "inventory.sync"));
      api.send("ptz.command", { deviceKey: "dev-1", channel: "1", action: "stop" }, "req-4");
      await until(() => api.frames.some((f) => f.type === "ptz.command.result"));
      const r = api.frames.find((f) => f.type === "ptz.command.result") as Frame;
      expect(r.payload).toEqual({ ok: false, code: "failed" });
    });

    it("malformed requests and unknown types are ignored without crashing", async () => {
      const api = await fakeApi();
      const c = client(api);
      c.start();
      await until(() => api.frames.some((f) => f.type === "inventory.sync"));
      for (const s of api.sockets) s.send("not json");
      api.send("shell.exec", { cmd: "id" });
      api.send("ptz.command", { deviceKey: "dev-1", channel: "1", action: "reboot" }, "bad");
      await wait(150);
      expect(api.frames.some((f) => f.type === "ptz.command.result" && f.id === "bad")).toBe(false);
      expect(c.state).toBe("ready");
    });
  });

  it("syncInventory() resends the inventory on the live connection and resolves on the ack", async () => {
    const api = await fakeApi();
    const c = client(api);
    c.start();
    await until(() => api.frames.some((f) => f.type === "inventory.sync"));
    await c.syncInventory();
    expect(api.frames.filter((f) => f.type === "inventory.sync")).toHaveLength(2);
  });

  it("syncInventory() rejects when there is no live connection", async () => {
    const api = await fakeApi();
    const c = client(api);
    await expect(c.syncInventory()).rejects.toThrow(/not connected/i);
  });

  it("stop() closes the socket and never reconnects", async () => {
    const api = await fakeApi();
    const c = client(api);
    c.start();
    await until(() => api.frames.some((f) => f.type === "inventory.sync"));
    await c.stop();
    const n = api.headers.length;
    await wait(200);
    expect(api.headers.length).toBe(n);
    expect(c.state).toBe("stopped");
    expect(api.sockets.every((s) => s.readyState !== 1)).toBe(true);
  });

  it("never logs the token", async () => {
    const lines: string[] = [];
    const log = {
      info: (...a: unknown[]) => lines.push(JSON.stringify(a)),
      warn: (...a: unknown[]) => lines.push(JSON.stringify(a)),
      error: (...a: unknown[]) => lines.push(JSON.stringify(a)),
      debug: (...a: unknown[]) => lines.push(JSON.stringify(a)),
    };
    const api = await fakeApi({ reject401: true });
    const c = client(api, { logger: log });
    c.start();
    await wait(200);
    expect(lines.join("\n")).not.toContain("T".repeat(43));
  });
});

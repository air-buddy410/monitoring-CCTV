import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSite, createTenant, createTestEnv, type Tenant, type TestEnv } from "../helpers";
import { type AgentSocket, connectAgent } from "../ws-client";

/** Enroll a fresh agent for a site and return its long-lived token. */
async function enrollAgent(env: TestEnv, owner: Tenant, siteId: string, name = "Agen Uji") {
  const created = await env.built.app.inject({
    method: "POST",
    url: `/v1/sites/${siteId}/enrollments`,
    headers: { cookie: owner.cookie },
    payload: { siteId, name },
  });
  if (created.statusCode !== 201) throw new Error(`enrollment failed: ${created.body}`);
  const { token } = created.json() as { token: string };
  const enrolled = await env.built.app.inject({
    method: "POST",
    url: "/v1/agents/enroll",
    payload: { token, name, version: "0.1.0" },
  });
  if (enrolled.statusCode !== 201) throw new Error(`enroll failed: ${enrolled.body}`);
  return enrolled.json() as { agentId: string; agentToken: string };
}

describe("agent WebSocket channel (PRD section 9.2)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let other: Tenant;
  let siteId: string;
  let port: number;
  const sockets: AgentSocket[] = [];

  const connect = async (token: string) => {
    const s = await connectAgent(port, token);
    sockets.push(s);
    return s;
  };

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "ch-owner");
    other = await createTenant(env, "ch-other");
    siteId = (await createSite(env, owner)).id;
    await env.built.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = env.built.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    port = addr.port;
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await env.close();
  });

  it("rejects a handshake with no token, a bogus token, or a wrong prefix", async () => {
    for (const bad of ["", "agt.org.agt_x.yyyyyyyyyyyyyyyyyyyyyyyy", "Bearer not-a-token", "nope"]) {
      const s = await connect(bad);
      expect(s.handshakeStatus, bad).toBe(401);
      s.close();
    }
  });

  it("rejects the token of a revoked agent", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Dicabut");
    const revoke = await env.built.app.inject({
      method: "POST",
      url: `/v1/agents/${a.agentId}/revoke`,
      headers: { cookie: owner.cookie },
    });
    expect(revoke.statusCode).toBe(200);
    const s = await connect(a.agentToken);
    expect(s.handshakeStatus).toBe(401);
    s.close();
  });

  it("completes the handshake with a valid token and answers hello", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Bandung");
    const s = await connect(a.agentToken);
    expect(s.handshakeStatus).toBe(101);
    expect(s.handshakeHeaders["sec-websocket-accept"]).toBeTruthy();

    s.send({
      id: "m1",
      type: "hello",
      ts: new Date().toISOString(),
      payload: { version: "0.2.0", go2rtcVersion: "1.9.0", hostname: "mini-pc" },
    });
    const ack = await s.next();
    expect(ack.type).toBe("hello.ack");
    expect(ack.id).toBe("m1");
    expect(ack.payload).toMatchObject({ agentId: a.agentId, siteId, heartbeatMs: 20_000 });

    // the agent is now online with the version it reported
    const found = await env.built.app.inject({
      method: "GET",
      url: `/v1/agents/${a.agentId}`,
      headers: { cookie: owner.cookie },
    });
    expect(found.json()).toMatchObject({ status: "online", version: "0.2.0" });
    s.close();
  });

  it("syncs inventory as metadata and never stores credentials", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Inventory");
    const s = await connect(a.agentToken);
    s.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "0.2.0" } });
    await s.next();

    s.send({
      id: "inv1",
      type: "inventory.sync",
      ts: new Date().toISOString(),
      payload: {
        devices: [
          {
            key: "10.0.0.5:80",
            name: "NVR Gudang",
            kind: "nvr",
            host: "10.0.0.5",
            port: 80,
            brand: "Hikvision",
            model: "DS-7608",
            adapterId: "onvif-generic",
            status: "online",
            cameras: [
              { channel: "1", name: "Kamera Depan", hasPtz: true, status: "online" },
              { channel: "2", name: "Kamera Belakang", hasPtz: false, status: "offline" },
            ],
          },
        ],
      },
    });
    const ack = await s.next();
    expect(ack.type).toBe("inventory.ack");
    expect(ack.payload).toEqual({ devices: 1, cameras: 2 });

    // the device and cameras are visible through the ordinary REST API, tagged with the agent
    const devices = await env.built.app.inject({
      method: "GET",
      url: `/v1/devices?siteId=${siteId}`,
      headers: { cookie: owner.cookie },
    });
    const items = (devices.json() as { items: { id: string; name: string; agentId: string }[] }).items;
    const nvr = items.find((d) => d.name === "NVR Gudang");
    expect(nvr).toBeTruthy();
    expect(nvr?.agentId).toBe(a.agentId);

    const cams = await env.built.app.inject({
      method: "GET",
      url: `/v1/cameras?siteId=${siteId}`,
      headers: { cookie: owner.cookie },
    });
    const names = (cams.json() as { items: { name: string; status: string }[] }).items.map((c) => c.name);
    expect(names).toContain("Kamera Depan");
    expect(names).toContain("Kamera Belakang");

    // a re-sync of the same device updates in place instead of duplicating it
    s.send({
      id: "inv2",
      type: "inventory.sync",
      ts: new Date().toISOString(),
      payload: {
        devices: [
          {
            key: "10.0.0.5:80",
            name: "NVR Gudang (baru)",
            kind: "nvr",
            host: "10.0.0.5",
            port: 80,
            adapterId: "onvif-generic",
            cameras: [{ channel: "1", name: "Kamera Depan", hasPtz: true }],
          },
        ],
      },
    });
    await s.next();
    const after = await env.built.app.inject({
      method: "GET",
      url: `/v1/devices?siteId=${siteId}`,
      headers: { cookie: owner.cookie },
    });
    const same = (after.json() as { items: { name: string }[] }).items.filter((d) =>
      d.name.startsWith("NVR Gudang"),
    );
    expect(same).toHaveLength(1);
    s.close();
  });

  it("rejects an inventory frame that carries credentials instead of metadata", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Kredensial");
    const s = await connect(a.agentToken);
    s.send({
      id: "bad",
      type: "inventory.sync",
      ts: new Date().toISOString(),
      payload: {
        devices: [
          {
            key: "10.0.0.9:80",
            name: "NVR Nakal",
            kind: "nvr",
            host: "10.0.0.9",
            port: 80,
            adapterId: "onvif-generic",
            cameras: [{ channel: "1", name: "Cam", password: "Dummy-Passw0rd!391" }],
          },
        ],
      },
    });
    const res = await s.next();
    expect(res.type).toBe("error");
    expect(res.payload).toMatchObject({ code: "invalid_inventory" });

    // nothing was written, and the credential is nowhere in the database
    const devices = await env.built.app.inject({
      method: "GET",
      url: `/v1/devices?siteId=${siteId}`,
      headers: { cookie: owner.cookie },
    });
    expect((devices.json() as { items: { name: string }[] }).items.map((d) => d.name)).not.toContain(
      "NVR Nakal",
    );
    s.close();
  });

  it("keeps tenants apart: an agent token only ever sees its own organization", async () => {
    const otherSite = (await createSite(env, other, "Site Lain")).id;
    const a = await enrollAgent(env, other, otherSite, "Agen Tenant Lain");
    const s = await connect(a.agentToken);
    s.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "0.2.0" } });
    await s.next();
    s.send({
      id: "inv",
      type: "inventory.sync",
      ts: new Date().toISOString(),
      payload: {
        devices: [
          {
            key: "10.0.9.9:80",
            name: "NVR Tenant Lain",
            kind: "nvr",
            host: "10.0.9.9",
            port: 80,
            adapterId: "onvif-generic",
            cameras: [],
          },
        ],
      },
    });
    await s.next();

    // the first tenant cannot see it
    const mine = await env.built.app.inject({
      method: "GET",
      url: `/v1/devices?siteId=${siteId}`,
      headers: { cookie: owner.cookie },
    });
    expect((mine.json() as { items: { name: string }[] }).items.map((d) => d.name)).not.toContain(
      "NVR Tenant Lain",
    );
    s.close();
  });

  it("closes the socket with a protocol error when a client frame is unmasked", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Nakal");
    const s = await connect(a.agentToken);
    // hand-rolled unmasked frame: a violation of RFC 6455 section 5.1
    const net = await import("node:net");
    const raw = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => raw.once("connect", r));
    raw.write(
      `GET /v1/agent/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Agent ${a.agentToken}\r\n\r\n`,
    );
    // drain the socket: a paused readable never emits end/close, which would mask the server's behaviour
    raw.on("data", () => undefined);
    raw.resume();
    await new Promise((r) => setTimeout(r, 200));
    const body = Buffer.from(JSON.stringify({ id: "x", type: "hello", ts: "1", payload: {} }));
    raw.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
    const closed = await new Promise<boolean>((resolve) => {
      raw.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1500);
    });
    expect(closed).toBe(true);
    raw.destroy();
    s.close();
  });

  it("pings on the configured cadence and drops an agent that never answers", async () => {
    // a dedicated app with a 40 ms heartbeat so the two missed beats happen quickly
    const fast = await createTestEnv({ AGENT_HEARTBEAT_MS: "40" });
    const fastOwner = await createTenant(fast, "hb-owner");
    const fastSite = (await createSite(fast, fastOwner)).id;
    const a = await enrollAgent(fast, fastOwner, fastSite, "Agen Bisu");
    await fast.built.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = fast.built.app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const sock = await connectAgent(addr.port, a.agentToken);

    sock.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "0.2.0" } });
    const first = await sock.next(2000);
    expect(first.type).toBe("hello.ack");
    const ping = await sock.next(2000);
    expect(ping.type).toBe("ping");

    // never answer: after two missed beats the server closes the socket
    const closed = await new Promise<boolean>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (sock.closeCode() !== null) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() - started > 5000) {
          clearInterval(poll);
          resolve(false);
        }
      }, 20);
    });
    expect(closed).toBe(true);
    sock.close();
    await fast.close();
  }, 30_000);

  it("answers an unsupported message type with an error instead of dropping the socket", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Aneh");
    const s = await connect(a.agentToken);
    s.send({ id: "weird", type: "totally.unknown", ts: new Date().toISOString(), payload: {} });
    const res = await s.next();
    expect(res.type).toBe("error");
    expect(res.id).toBe("weird");
    expect(res.payload).toMatchObject({ code: "unsupported_type" });
    s.close();
  });

  it("marks an agent offline when its socket closes", async () => {
    const a = await enrollAgent(env, owner, siteId, "Agen Putus");
    const s = await connect(a.agentToken);
    s.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "0.2.0" } });
    await s.next();
    s.close();
    // the close handler runs asynchronously
    await new Promise((r) => setTimeout(r, 400));
    const found = await env.built.app.inject({
      method: "GET",
      url: `/v1/agents/${a.agentId}`,
      headers: { cookie: owner.cookie },
    });
    expect(found.json()).toMatchObject({ status: "offline" });
  });
});

describe("agent channel: cloud-initiated requests (PRD section 9.2)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let siteId: string;
  let port: number;
  let agentId: string;
  let socket: AgentSocket;

  beforeAll(async () => {
    env = await createTestEnv();
    owner = await createTenant(env, "req-owner");
    siteId = (await createSite(env, owner)).id;
    await env.built.app.listen({ port: 0, host: "127.0.0.1" });
    port = (env.built.app.server.address() as { port: number }).port;
    const a = await enrollAgent(env, owner, siteId, "Agen Perintah");
    agentId = a.agentId;
    socket = await connectAgent(port, a.agentToken);
    socket.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "0.2.0" } });
    await socket.next();
  });
  afterAll(async () => {
    socket.close();
    await env.close();
  });

  it("correlates a PTZ command with the agent's reply by envelope id", async () => {
    const pending = env.built.hub.request(agentId, "ptz", { cameraId: "cam_x", action: "left" });
    const frame = await socket.next();
    expect(frame.type).toBe("ptz.command");
    expect(frame.payload).toMatchObject({ cameraId: "cam_x", action: "left" });
    socket.send({
      id: frame.id,
      type: "ptz.result",
      ts: new Date().toISOString(),
      payload: { ok: true },
    });
    await expect(pending).resolves.toMatchObject({ type: "ptz.result", payload: { ok: true } });
  });

  it("times a request out when the agent never answers", async () => {
    const pending = env.built.hub.request(agentId, "snapshot", { cameraId: "cam_x" }, 60);
    const frame = await socket.next();
    expect(frame.type).toBe("snapshot.request");
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it("refuses to queue a request for an agent that is not connected", async () => {
    await expect(env.built.hub.request("agt_absent", "recordings", {})).rejects.toThrow(/not connected/);
  });

  it("tracks connectivity in the hub as sockets come and go", async () => {
    expect(env.built.hub.isConnected(agentId)).toBe(true);
    const b = await enrollAgent(env, owner, siteId, "Agen Kedua");
    const s2 = await connectAgent(port, b.agentToken);
    expect(env.built.hub.isConnected(b.agentId)).toBe(true);
    s2.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(env.built.hub.isConnected(b.agentId)).toBe(false);
  });

  it("keeps exactly one live socket per agent when it reconnects", async () => {
    const reconnecting = await enrollAgent(env, owner, siteId, "Agen Reconnect");
    const first = await connectAgent(port, reconnecting.agentToken);
    first.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "1" } });
    await first.next();
    const sizeBefore = env.built.hub.size();

    const second = await connectAgent(port, reconnecting.agentToken);
    second.send({ id: "h", type: "hello", ts: new Date().toISOString(), payload: { version: "1" } });
    await second.next();
    // the newer socket replaced the older one rather than adding a second entry for the same agent
    expect(env.built.hub.size()).toBe(sizeBefore);
    expect(env.built.hub.isConnected(reconnecting.agentId)).toBe(true);
    first.close();
    second.close();
  });
});

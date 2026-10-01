import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentOfflineError, AgentTimeoutError } from "../../src/agent-hub";
import {
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  newAgentPublicKey,
  type Tenant,
  type TestEnv,
} from "../helpers";

interface Frame {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}
interface Enrolled {
  agentId: string;
  agentToken: string;
}

const device = (over: Record<string, unknown> = {}) => ({
  deviceKey: "dev-1",
  name: "NVR Lab",
  kind: "nvr",
  brand: "mockvendor",
  model: "MV-NVR-2",
  firmware: "9.9.9-mock",
  adapterId: "onvif-generic",
  host: "192.168.1.20",
  port: 80,
  capabilities: { live: "ya", snapshot: "ya", ptz: "belum-diuji" },
  cameras: [
    { channel: "1", name: "Pintu Depan", hasPtz: false, mainCodec: "H264", subCodec: "H264" },
    { channel: "2", name: "Gudang", hasPtz: true, mainCodec: "H265", subCodec: null },
  ],
  ...over,
});

describe("agent WebSocket /agent (PRD 9.2)", () => {
  let env: TestEnv;
  let wsUrl: string;
  let owner: Tenant;
  let noc: Tenant;
  let other: Tenant;
  let siteId: string;
  const sockets: WebSocket[] = [];

  const call = (who: Tenant, method: "GET" | "POST", url: string, payload?: unknown) =>
    env.built.app.inject({ method, url, headers: { cookie: who.cookie }, payload: payload as never });

  async function newAgent(t: Tenant, site: string, name = "Agen WS"): Promise<Enrolled> {
    const enr = (await call(t, "POST", `/v1/sites/${site}/enrollments`, {})).json() as { token: string };
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/agent/enroll",
      headers: { authorization: `Enroll ${enr.token}` },
      payload: { name, publicKey: newAgentPublicKey() },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as Enrolled;
  }

  /** Raw client: records every frame the server sends and every close. */
  function connect(token: string | null, opts: { autoPong?: boolean; scheme?: string } = {}) {
    const headers: Record<string, string> =
      token === null ? {} : { authorization: `${opts.scheme ?? "Agent"} ${token}` };
    const ws = new WebSocket(`${wsUrl}/agent`, { headers, autoPong: opts.autoPong ?? true });
    sockets.push(ws);
    const frames: Frame[] = [];
    const waiters: { type: string; resolve: (f: Frame) => void }[] = [];
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString()) as Frame;
      frames.push(f);
      for (const w of [...waiters]) {
        if (w.type === f.type) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    const rejected = new Promise<{ status: number; body: string }>((resolve) =>
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }),
    );
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    return {
      ws,
      frames,
      opened,
      closed,
      rejected,
      next: (type: string) =>
        new Promise<Frame>((resolve, reject) => {
          const hit = frames.find((f) => f.type === type);
          if (hit) return resolve(hit);
          const t = setTimeout(() => reject(new Error(`no ${type} frame`)), 3000);
          waiters.push({ type, resolve: (f) => (clearTimeout(t), resolve(f)) });
        }),
      send(type: string, payload: unknown, id: string = randomUUID()) {
        ws.send(JSON.stringify({ id, type, ts: new Date().toISOString(), payload }));
        return id;
      },
      raw: (s: string | Buffer) => ws.send(s),
    };
  }
  const hello = { agentVersion: "0.1.0", go2rtcVersion: "1.9.9", hostname: "mini-pc-lab" };
  async function online(token: string) {
    const c = connect(token);
    await c.opened;
    const id = c.send("hello", hello);
    const ack = await c.next("ack");
    expect(ack.id).toBe(id);
    return c;
  }
  const until = async (fn: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const dbAgent = async (id: string) =>
    (
      await env.admin.query(
        `select status, version, go2rtc_version, hostname, last_status, last_seen_at from agent where id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    env = await createTestEnv({ AGENT_PING_INTERVAL_MS: "200", AGENT_MAX_MESSAGES_PER_10S: "30" });
    wsUrl = (await env.listen()).wsUrl;
    owner = await createTenant(env, "ws-owner");
    noc = await addMemberWithRole(env, owner, "ws-noc", "noc");
    other = await createTenant(env, "ws-other");
    siteId = (await createSite(env, owner)).id;
  });
  afterAll(async () => {
    for (const s of sockets) s.terminate();
    await env.close();
  });

  describe("authentication happens before the upgrade", () => {
    it("refuses a missing, malformed, unknown, wrong-scheme or enrollment token with 401 and opens no socket", async () => {
      const agent = await newAgent(owner, siteId);
      const enr = (
        (await call(owner, "POST", `/v1/sites/${siteId}/enrollments`, {})).json() as { token: string }
      ).token;
      const attempts = [
        connect(null),
        connect("pat_" + "A".repeat(43)),
        connect("garbage"),
        connect(agent.agentToken, { scheme: "Bearer" }),
        connect(agent.agentToken, { scheme: "Enroll" }),
        connect(enr),
      ];
      for (const a of attempts) {
        a.opened.catch(() => undefined);
        const r = await a.rejected;
        expect(r.status).toBe(401);
        expect(JSON.parse(r.body).code).toBe("agent_unauthorized");
      }
      expect(env.built.hub.isOnline(agent.agentId)).toBe(false);
    });

    it("refuses a revoked agent", async () => {
      const agent = await newAgent(owner, siteId);
      await call(owner, "POST", `/v1/agents/${agent.agentId}/revoke`, {});
      const c = connect(agent.agentToken);
      c.opened.catch(() => undefined);
      expect((await c.rejected).status).toBe(401);
      expect((await dbAgent(agent.agentId)).status).toBe("revoked");
    });

    it("a cookie session is not an agent credential", async () => {
      const c = new WebSocket(`${wsUrl}/agent`, { headers: { cookie: owner.cookie } });
      sockets.push(c);
      const status = await new Promise<number>((resolve) => {
        c.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
        c.on("error", () => undefined);
      });
      expect(status).toBe(401);
    });
  });

  describe("hello and presence", () => {
    it("hello is acknowledged with the same id; the agent becomes online with its version and hostname", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      expect(env.built.hub.isOnline(agent.agentId)).toBe(true);
      const row = await dbAgent(agent.agentId);
      expect(row).toMatchObject({
        status: "online",
        version: "0.1.0",
        go2rtc_version: "1.9.9",
        hostname: "mini-pc-lab",
      });
      expect(row.last_seen_at).not.toBeNull();
      const api = (await call(noc, "GET", `/v1/agents/${agent.agentId}`)).json() as { status: string };
      expect(api.status).toBe("online");
      c.ws.close();
      await c.closed;
      expect(await until(async () => (await dbAgent(agent.agentId)).status === "offline")).toBe(true);
      expect(
        ((await call(noc, "GET", `/v1/agents/${agent.agentId}`)).json() as { status: string }).status,
      ).toBe("offline");
    });

    it("anything before hello is answered with hello_required and changes nothing", async () => {
      const agent = await newAgent(owner, siteId);
      const c = connect(agent.agentToken);
      await c.opened;
      const id = c.send("inventory.sync", { devices: [device()] });
      const err = await c.next("error");
      expect(err.id).toBe(id);
      expect(err.payload.code).toBe("hello_required");
      const n = await env.admin.query(`select count(*)::int as n from device where agent_id = $1`, [
        agent.agentId,
      ]);
      expect(n.rows[0].n).toBe(0);
    });

    it("a second connection with the same token replaces the first", async () => {
      const agent = await newAgent(owner, siteId);
      const first = await online(agent.agentToken);
      const second = await online(agent.agentToken);
      expect((await first.closed).code).toBe(4409);
      expect(env.built.hub.isOnline(agent.agentId)).toBe(true);
      // the old socket closing must not flip the live agent to offline
      await new Promise((r) => setTimeout(r, 100));
      expect((await dbAgent(agent.agentId)).status).toBe("online");
      second.ws.close();
    });

    it("revoking closes a live connection with 4401 and it cannot come back", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      await call(noc, "POST", `/v1/agents/${agent.agentId}/revoke`, {});
      expect((await c.closed).code).toBe(4401);
      const again = connect(agent.agentToken);
      again.opened.catch(() => undefined);
      expect((await again.rejected).status).toBe(401);
      expect((await dbAgent(agent.agentId)).status).toBe("revoked");
    });
  });

  describe("heartbeat", () => {
    it("the server pings; a client that never answers is terminated, one that answers stays", async () => {
      const a = await newAgent(owner, siteId);
      const b = await newAgent(owner, siteId);
      const mute = connect(a.agentToken, { autoPong: false });
      const live = connect(b.agentToken);
      await Promise.all([mute.opened, live.opened]);
      mute.send("hello", hello);
      live.send("hello", hello);
      let pings = 0;
      live.ws.on("ping", () => pings++);
      await mute.closed;
      expect(env.built.hub.isOnline(a.agentId)).toBe(false);
      expect(live.ws.readyState).toBe(WebSocket.OPEN);
      expect(pings).toBeGreaterThanOrEqual(1);
      live.ws.close();
    });
  });

  describe("hostile frames", () => {
    it("not JSON, a JSON array, an unknown type and a bad payload each get an error frame and the socket survives", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.raw("not json");
      c.raw("[]");
      c.send("shell.exec", { cmd: "id" });
      const bad = c.send("status", { cameras: [], cpuPercent: 999, memUsedPercent: 1, diskUsedPercent: 1 });
      await until(async () => c.frames.filter((f) => f.type === "error").length >= 4);
      const errors = c.frames.filter((f) => f.type === "error");
      expect(errors.map((e) => e.payload.code)).toEqual([
        "invalid_message",
        "invalid_message",
        "unsupported_type",
        "invalid_payload",
      ]);
      expect(errors[3]?.id).toBe(bad);
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
      c.ws.close();
    });

    it("an oversized frame closes the connection with 1009", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.raw(
        JSON.stringify({
          id: "x",
          type: "status",
          ts: new Date().toISOString(),
          payload: { pad: "x".repeat(300 * 1024) },
        }),
      );
      expect((await c.closed).code).toBe(1009);
    });

    it("a binary frame is refused", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.raw(Buffer.from([1, 2, 3]));
      const err = await c.next("error");
      expect(err.payload.code).toBe("invalid_message");
      c.ws.close();
    });

    it("five invalid frames in a row close the connection with 1008", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      for (let i = 0; i < 6; i++) c.raw("nope");
      expect((await c.closed).code).toBe(1008);
    });

    it("flooding closes the connection with 1008 and later frames are not processed", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      for (let i = 0; i < 80; i++)
        c.send("status", { cameras: [], cpuPercent: 1, memUsedPercent: 1, diskUsedPercent: 1 });
      expect((await c.closed).code).toBe(1008);
    });

    it("event.motion is a known type but not handled before M4: it is refused, not silently accepted", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.send("event.motion", {
        deviceKey: "dev-1",
        channel: "1",
        at: new Date().toISOString(),
        thumbnailBase64: "",
      });
      const err = await c.next("error");
      expect(err.payload.code).toBe("unsupported_type");
      c.ws.close();
    });
  });

  describe("inventory.sync (metadata only)", () => {
    it("creates devices and cameras owned by the agent, with no stored device credentials", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      const id = c.send("inventory.sync", { devices: [device()] });
      await until(async () => c.frames.some((f) => f.type === "ack" && f.id === id));
      const ack = c.frames.find((f) => f.type === "ack" && f.id === id) as Frame;
      const sync = (
        ack.payload as {
          devices: { deviceKey: string; id: string; cameras: { channel: string; id: string }[] }[];
        }
      ).devices;
      expect(sync).toHaveLength(1);
      expect(sync[0]?.cameras).toHaveLength(2);
      const devs = await env.admin.query(
        `select id, site_id, organization_id, agent_id, agent_device_key, brand, model, host, port, kind, status from device where agent_id = $1`,
        [agent.agentId],
      );
      expect(devs.rows).toHaveLength(1);
      expect(devs.rows[0]).toMatchObject({
        site_id: siteId,
        organization_id: owner.orgId,
        agent_device_key: "dev-1",
        brand: "mockvendor",
        host: "192.168.1.20",
        port: 80,
        kind: "nvr",
        status: "unknown",
      });
      const cams = await env.admin.query(
        `select channel, name, has_ptz, main_codec, sub_codec, status from camera where device_id = $1 order by channel`,
        [devs.rows[0].id],
      );
      expect(cams.rows.map((r) => [r.channel, r.name, r.has_ptz, r.status])).toEqual([
        ["1", "Pintu Depan", false, "unknown"],
        ["2", "Gudang", true, "unknown"],
      ]);
      const secrets = await env.admin.query(
        `select count(*)::int as n from device_secret where device_id = $1`,
        [devs.rows[0].id],
      );
      expect(secrets.rows[0].n).toBe(0);
      // visible through the normal API, in this tenant only
      const list = (await call(owner, "GET", `/v1/devices?siteId=${siteId}`)).json() as {
        items: { id: string }[];
      };
      expect(list.items.map((d) => d.id)).toContain(devs.rows[0].id);
      const bList = (await call(other, "GET", "/v1/devices")).json() as { items: { id: string }[] };
      expect(bList.items.map((d) => d.id)).not.toContain(devs.rows[0].id);
      const audit = await env.admin.query(
        `select actor_id, meta from audit_log where organization_id = $1 and action = 'agent.inventory.sync' and target = $2`,
        [owner.orgId, agent.agentId],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].actor_id).toBeNull();
      c.ws.close();
    });

    it("is idempotent: syncing twice makes no duplicates, and a rename by an operator survives a re-sync", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.send("inventory.sync", { devices: [device()] });
      await until(async () => c.frames.filter((f) => f.type === "ack").length >= 2);
      const camId = (
        await env.admin.query(
          `select c.id from camera c join device d on d.id = c.device_id where d.agent_id = $1 and c.channel = '1'`,
          [agent.agentId],
        )
      ).rows[0].id as string;
      expect(
        (
          await call(owner, "POST", "/v1/grants", {
            userId: owner.userId,
            scope: "camera",
            scopeId: camId,
            permission: "view",
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(200);
      const patch = await env.built.app.inject({
        method: "PATCH",
        url: `/v1/cameras/${camId}`,
        headers: { cookie: owner.cookie },
        payload: { name: "Nama Operator", sortOrder: 9 },
      });
      expect(patch.statusCode).toBe(200);
      c.send("inventory.sync", { devices: [device({ model: "MV-NVR-3", name: "NVR Baru" })] });
      await until(async () => c.frames.filter((f) => f.type === "ack").length >= 3);
      const devs = await env.admin.query(`select model, name from device where agent_id = $1`, [
        agent.agentId,
      ]);
      expect(devs.rows).toEqual([{ model: "MV-NVR-3", name: "NVR Baru" }]);
      const cam = await env.admin.query(`select name, sort_order from camera where id = $1`, [camId]);
      expect(cam.rows[0]).toEqual({ name: "Nama Operator", sort_order: 9 });
      const count = await env.admin.query(
        `select count(*)::int as n from camera c join device d on d.id = c.device_id where d.agent_id = $1`,
        [agent.agentId],
      );
      expect(count.rows[0].n).toBe(2);
      c.ws.close();
    });

    it("devices and cameras that disappear are marked missing, not deleted; they return when reported again", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.send("inventory.sync", {
        devices: [
          device(),
          device({
            deviceKey: "dev-2",
            name: "IPC",
            host: "192.168.1.21",
            kind: "ipc",
            cameras: [{ channel: "1", name: "Atap", hasPtz: false, mainCodec: null, subCodec: null }],
          }),
        ],
      });
      await until(async () =>
        c.frames.some((f) => f.type === "ack" && (f.payload.devices as unknown[] | undefined)?.length === 2),
      );
      c.send("inventory.sync", {
        devices: [
          device({
            cameras: [
              { channel: "1", name: "Pintu Depan", hasPtz: false, mainCodec: "H264", subCodec: "H264" },
            ],
          }),
        ],
      });
      await until(async () => c.frames.filter((f) => f.type === "ack" && f.payload.devices).length >= 2);
      const st = await env.admin.query(
        `select d.agent_device_key as k, d.status as ds, c.channel, c.status as cs from device d left join camera c on c.device_id = d.id where d.agent_id = $1 order by 1, 3`,
        [agent.agentId],
      );
      expect(st.rows).toEqual([
        { k: "dev-1", ds: "unknown", channel: "1", cs: "unknown" },
        { k: "dev-1", ds: "unknown", channel: "2", cs: "missing" },
        { k: "dev-2", ds: "missing", channel: "1", cs: "missing" },
      ]);
      c.send("inventory.sync", { devices: [device()] });
      await until(async () => c.frames.filter((f) => f.type === "ack" && f.payload.devices).length >= 3);
      const back = await env.admin.query(
        `select c.status from camera c join device d on d.id = c.device_id where d.agent_id = $1 and d.agent_device_key = 'dev-1' order by c.channel`,
        [agent.agentId],
      );
      expect(back.rows.map((r) => r.status)).toEqual(["unknown", "unknown"]);
      c.ws.close();
    });

    it("rejects credentials, stream addresses and unknown fields: error frame, nothing written", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      const attempts = [
        { devices: [device({ password: "Dummy-Sentinel-Pw-7391!" })] },
        { devices: [device({ username: "admin" })] },
        { devices: [device({ rtspUri: "rtsp://admin:pw@192.168.1.20/s" })] },
        {
          devices: [
            device({
              cameras: [
                {
                  channel: "1",
                  name: "x",
                  hasPtz: false,
                  mainCodec: null,
                  subCodec: null,
                  snapshotUri: "http://u:p@h/s",
                },
              ],
            }),
          ],
        },
        { devices: [device()], token: "pat_x" },
      ];
      for (const a of attempts) {
        c.send("inventory.sync", a);
        // a valid frame in between: five invalid frames in a row would (rightly) close the socket
        c.send("status", { cameras: [], cpuPercent: 1, memUsedPercent: 1, diskUsedPercent: 1 });
      }
      await until(async () => c.frames.filter((f) => f.type === "error").length >= attempts.length);
      const errors = c.frames.filter((f) => f.type === "error");
      expect(errors).toHaveLength(attempts.length);
      for (const e of errors) expect(["forbidden_field", "invalid_payload"]).toContain(e.payload.code);
      expect(JSON.stringify(errors)).not.toContain("Dummy-Sentinel-Pw-7391!");
      const n = await env.admin.query(`select count(*)::int as n from device where agent_id = $1`, [
        agent.agentId,
      ]);
      expect(n.rows[0].n).toBe(0);
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
      c.ws.close();
    });

    it("two agents may use the same deviceKey, in the same or in different tenants, without touching each other", async () => {
      const otherSite = (await createSite(env, other)).id;
      const a = await newAgent(owner, siteId);
      const b = await newAgent(other, otherSite);
      const ca = await online(a.agentToken);
      const cb = await online(b.agentToken);
      ca.send("inventory.sync", { devices: [device({ model: "A-MODEL" })] });
      cb.send("inventory.sync", { devices: [device({ model: "B-MODEL" })] });
      await Promise.all([
        until(async () => ca.frames.some((f) => f.payload.devices)),
        until(async () => cb.frames.some((f) => f.payload.devices)),
      ]);
      const rows = await env.admin.query(
        `select organization_id, agent_id, model from device where agent_id = any($1) order by model`,
        [[a.agentId, b.agentId]],
      );
      expect(rows.rows).toEqual([
        { organization_id: owner.orgId, agent_id: a.agentId, model: "A-MODEL" },
        { organization_id: other.orgId, agent_id: b.agentId, model: "B-MODEL" },
      ]);
      // B's second sync, with fewer devices, cannot mark A's device missing
      cb.send("inventory.sync", { devices: [] });
      await until(async () => cb.frames.filter((f) => f.payload.devices).length >= 2);
      const aDev = await env.admin.query(`select status from device where agent_id = $1`, [a.agentId]);
      expect(aDev.rows[0].status).toBe("unknown");
      ca.ws.close();
      cb.ws.close();
    });
  });

  describe("status every 30 seconds", () => {
    it("updates last_status, last_seen and the status of this agent's cameras only", async () => {
      const a = await newAgent(owner, siteId);
      const b = await newAgent(owner, siteId);
      const ca = await online(a.agentToken);
      const cb = await online(b.agentToken);
      ca.send("inventory.sync", { devices: [device()] });
      cb.send("inventory.sync", { devices: [device()] });
      await Promise.all([
        until(async () => ca.frames.some((f) => f.payload.devices)),
        until(async () => cb.frames.some((f) => f.payload.devices)),
      ]);
      const before = (await dbAgent(a.agentId)).last_seen_at as Date;
      await new Promise((r) => setTimeout(r, 20));
      ca.send("status", {
        cameras: [
          { deviceKey: "dev-1", channel: "1", online: true },
          { deviceKey: "dev-1", channel: "2", online: false },
          { deviceKey: "dev-nope", channel: "1", online: true },
        ],
        cpuPercent: 12.5,
        memUsedPercent: 40,
        diskUsedPercent: 71.2,
        uptimeSec: 3600,
      });
      expect(await until(async () => (await dbAgent(a.agentId)).last_status !== null)).toBe(true);
      const row = await dbAgent(a.agentId);
      expect(row.last_status).toMatchObject({
        cpuPercent: 12.5,
        memUsedPercent: 40,
        diskUsedPercent: 71.2,
        uptimeSec: 3600,
        camerasOnline: 1,
        camerasTotal: 2,
      });
      expect((row.last_seen_at as Date).getTime()).toBeGreaterThan(before.getTime());
      const cams = await env.admin.query(
        `select d.agent_id, c.channel, c.status, d.status as ds from camera c join device d on d.id = c.device_id where d.agent_id = any($1) order by d.agent_id, c.channel`,
        [[a.agentId, b.agentId]],
      );
      const mine = cams.rows.filter((r) => r.agent_id === a.agentId);
      const theirs = cams.rows.filter((r) => r.agent_id === b.agentId);
      expect(mine.map((r) => [r.channel, r.status, r.ds])).toEqual([
        ["1", "online", "online"],
        ["2", "offline", "online"],
      ]);
      expect(theirs.every((r) => r.status === "unknown")).toBe(true);
      const api = (await call(noc, "GET", `/v1/agents/${a.agentId}`)).json() as {
        lastStatus: { camerasOnline: number };
      };
      expect(api.lastStatus.camerasOnline).toBe(1);
      ca.ws.close();
      cb.ws.close();
    });
  });

  describe("requests from the API to an agent, with timeouts", () => {
    const env2 = () => env.built.hub;
    const req = (id: string, type = "ptz.command") => ({
      id,
      type,
      ts: new Date().toISOString(),
      payload: { deviceKey: "dev-1", channel: "1", action: "stop" },
    });

    it("resolves with the agent's reply that carries the same id", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      c.ws.on("message", (d) => {
        const f = JSON.parse(d.toString()) as Frame;
        if (f.type === "ptz.command") c.send("ptz.command.result", { ok: true }, f.id);
      });
      const out = await env2().request(agent.agentId, req("req-1"), 1000);
      expect(out).toEqual({ ok: true });
      c.ws.close();
    });

    it("rejects with a timeout when the agent stays silent, and a late reply is ignored", async () => {
      const agent = await newAgent(owner, siteId);
      const c = await online(agent.agentToken);
      const started = Date.now();
      await expect(env2().request(agent.agentId, req("req-2"), 150)).rejects.toBeInstanceOf(
        AgentTimeoutError,
      );
      expect(Date.now() - started).toBeLessThan(1000);
      c.send("ptz.command.result", { ok: true }, "req-2");
      const err = await c.next("error");
      expect(err.payload.code).toBe("unexpected_result");
      c.ws.close();
    });

    it("rejects at once for an offline agent and when the agent disconnects mid-request", async () => {
      const agent = await newAgent(owner, siteId);
      await expect(env2().request(agent.agentId, req("req-3"), 500)).rejects.toBeInstanceOf(
        AgentOfflineError,
      );
      const c = await online(agent.agentToken);
      const p = env2().request(agent.agentId, req("req-4"), 5000);
      c.ws.close();
      await expect(p).rejects.toBeInstanceOf(AgentOfflineError);
    });
  });

  it("agent traffic is never written to the logs", async () => {
    const agent = await newAgent(owner, siteId);
    const c = await online(agent.agentToken);
    c.send("inventory.sync", { devices: [device({ name: "NamaUnikTidakBolehDiLog" })] });
    await until(async () => c.frames.some((f) => f.payload.devices));
    c.ws.close();
    await c.closed;
    const all = env.logs.join("\n");
    expect(all).not.toContain("NamaUnikTidakBolehDiLog");
    expect(all).not.toContain(agent.agentToken);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Agent, createLogger } from "@pantau/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMemberWithRole,
  createSite,
  createTenant,
  createTestEnv,
  DEVICE_PASSWORD,
  DEVICE_USERNAME,
  giveAccess,
  newAgentPublicKey,
  type Tenant,
  type TestEnv,
  USER_PASSWORD,
} from "../helpers";
import { fakeAgent, recordingProxy } from "../wire";

const jpeg = (bytes: number) => {
  const b = Buffer.alloc(bytes, 0x41);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  b[bytes - 2] = 0xff;
  b[bytes - 1] = 0xd9;
  return b;
};

describe("snapshot through the agent: the cloud never touches the camera and never holds its credentials", () => {
  let env: TestEnv;
  let owner: Tenant;
  let noc: Tenant;
  let operator: Tenant;
  let viewer: Tenant;
  let other: Tenant;
  let siteId: string;
  let httpUrl: string;
  let wsUrl: string;
  let proxy: Awaited<ReturnType<typeof recordingProxy>>;
  const agents: Agent[] = [];
  const stops: (() => void)[] = [];
  const agentLogs: string[] = [];
  const logStream = new Writable({
    write(c, _e, cb) {
      agentLogs.push(c.toString());
      cb();
    },
  });
  const until = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  const snap = (who: Tenant, cameraId: string) =>
    env.built.app.inject({
      method: "POST",
      url: `/v1/cameras/${cameraId}/snapshot`,
      headers: { cookie: who.cookie },
    });
  const token = async (t: Tenant, site: string) =>
    (
      (
        await env.built.app.inject({
          method: "POST",
          url: `/v1/sites/${site}/enrollments`,
          headers: { cookie: t.cookie },
          payload: {},
        })
      ).json() as { token: string }
    ).token;

  async function realAgent(t: Tenant, site: string, name: string) {
    const agent = await Agent.enroll({
      apiUrl: httpUrl,
      wsUrl: proxy.url,
      enrollToken: await token(t, site),
      dataDir: mkdtempSync(join(tmpdir(), "pantau-snap-")),
      name,
      allowLoopback: true,
      allowInsecure: true,
      logger: createLogger("debug", logStream),
      client: {
        statusIntervalMs: 200,
        pingIntervalMs: 500,
        pongTimeoutMs: 1000,
        ackTimeoutMs: 2000,
        backoff: () => 50,
      },
    });
    agents.push(agent);
    agent.start();
    expect(await until(() => agent.client.state === "ready")).toBe(true);
    return agent;
  }
  async function cameraOf(agentId: string): Promise<string> {
    const r = await env.admin.query(
      `select c.id from camera c join device d on d.id = c.device_id where d.agent_id = $1 order by c.sort_order limit 1`,
      [agentId],
    );
    return r.rows[0].id as string;
  }
  async function enrollRaw(t: Tenant, site: string): Promise<{ agentId: string; agentToken: string }> {
    const res = await env.built.app.inject({
      method: "POST",
      url: "/v1/agent/enroll",
      headers: { authorization: `Enroll ${await token(t, site)}` },
      payload: { name: "Agen Palsu", publicKey: newAgentPublicKey() },
    });
    return res.json() as { agentId: string; agentToken: string };
  }

  beforeAll(async () => {
    env = await createTestEnv({ AGENT_SNAPSHOT_TIMEOUT_MS: "500" });
    const u = await env.listen();
    httpUrl = u.httpUrl;
    wsUrl = u.wsUrl;
    proxy = await recordingProxy(wsUrl);
    owner = await createTenant(env, "as-owner");
    noc = await addMemberWithRole(env, owner, "as-noc", "noc");
    operator = await addMemberWithRole(env, owner, "as-op", "admin");
    viewer = await addMemberWithRole(env, owner, "as-vw", "member");
    other = await createTenant(env, "as-other");
    siteId = (await createSite(env, owner)).id;
  });
  afterAll(async () => {
    for (const s of stops) s();
    await Promise.all(agents.map((a) => a.stop()));
    await proxy.stop();
    await env.close();
  });

  it("returns the camera's JPEG, taken by the agent with credentials that never left it", async () => {
    const frame = jpeg(40_000);
    const mock = await env.startMock({ channels: 2, snapshotBody: frame });
    const agent = await realAgent(owner, siteId, "Agen Snapshot");
    await agent.addDevice({
      name: "NVR Simulasi",
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    const cam = await (async () => {
      await until(
        async () =>
          (await env.admin.query(`select 1 from device where agent_id = $1`, [agent.identity.agentId]))
            .rowCount === 1,
      );
      return cameraOf(agent.identity.agentId);
    })();
    const before = mock.snapshotRequestCount();
    const res = await snap(owner, cam);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(Buffer.compare(res.rawPayload, frame)).toBe(0);
    expect(mock.snapshotRequestCount()).toBe(before + 1);

    const audit = await env.admin.query(
      `select meta from audit_log where organization_id = $1 and action = 'camera.snapshot' and target = $2 order by at desc limit 1`,
      [owner.orgId, cam],
    );
    expect(audit.rows[0].meta).toMatchObject({
      via: "agent",
      agentId: agent.identity.agentId,
      bytes: frame.length,
    });

    // the request frame names a device and a channel and nothing else
    const req = proxy.wire
      .filter((w) => w.dir === "api->agent")
      .map((w) => JSON.parse(w.text) as { type: string; payload: Record<string, unknown> })
      .find((f) => f.type === "snapshot.request");
    expect(Object.keys(req?.payload ?? {}).sort()).toEqual(["channel", "deviceKey"]);

    // sentinel scan after a real snapshot: database, logs, every frame, in both directions
    const tables = (
      await env.admin.query(`select tablename from pg_tables where schemaname = 'public'`)
    ).rows.map((r) => r.tablename as string);
    for (const t of tables) {
      const hit = await env.admin.query(
        `select count(*)::int as n from "${t}" x where x::text like $1 or x::text like $2`,
        [`%${DEVICE_PASSWORD}%`, `%${DEVICE_USERNAME}%`],
      );
      expect(hit.rows[0].n, `table ${t}`).toBe(0);
    }
    for (const [label, text] of [
      ["API logs", env.logs.join("\n")],
      ["agent logs", agentLogs.join("\n")],
      [
        "frames",
        proxy.wire
          .map((w) => w.text)
          .join("\n")
          .replace(/"jpegBase64":"[^"]*"/g, '"jpegBase64":"..."'),
      ],
    ] as const) {
      expect(text.includes(DEVICE_PASSWORD), `${label} contain the device password`).toBe(false);
      expect(text.includes(DEVICE_USERNAME), `${label} contain the device user name`).toBe(false);
    }
    await mock.stop();
  });

  it("a frame bigger than the 128 KB limit still arrives, up to 1 MiB; beyond that the agent refuses and reports it", async () => {
    const big = jpeg(500_000);
    const mock = await env.startMock({ channels: 1, snapshotBody: big });
    const agent = await realAgent(owner, siteId, "Agen Besar");
    await agent.addDevice({
      name: "Besar",
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    await until(
      async () =>
        (await env.admin.query(`select 1 from device where agent_id = $1`, [agent.identity.agentId]))
          .rowCount === 1,
    );
    const cam = await cameraOf(agent.identity.agentId);
    const ok = await snap(owner, cam);
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.length).toBe(500_000);
    await mock.stop();

    const huge = jpeg(1_200_000);
    const mock2 = await env.startMock({ channels: 1, snapshotBody: huge });
    const agent2 = await realAgent(owner, siteId, "Agen Terlalu Besar");
    await agent2.addDevice({
      name: "Terlalu besar",
      host: mock2.host,
      port: mock2.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    await until(
      async () =>
        (await env.admin.query(`select 1 from device where agent_id = $1`, [agent2.identity.agentId]))
          .rowCount === 1,
    );
    const res = await snap(owner, await cameraOf(agent2.identity.agentId));
    expect(res.statusCode).toBe(502);
    expect((res.json() as { code: string }).code).toBe("snapshot_too_large");
    await mock2.stop();
  });

  describe("who may ask", () => {
    let cam: string;
    let mock: Awaited<ReturnType<TestEnv["startMock"]>>;
    let agent: Agent;
    beforeAll(async () => {
      mock = await env.startMock({ channels: 1, snapshotBody: jpeg(5_000) });
      agent = await realAgent(owner, siteId, "Agen Peran");
      await agent.addDevice({
        name: "Peran",
        host: mock.host,
        port: mock.port,
        username: DEVICE_USERNAME,
        password: DEVICE_PASSWORD,
      });
      await until(
        async () =>
          (await env.admin.query(`select 1 from device where agent_id = $1`, [agent.identity.agentId]))
            .rowCount === 1,
      );
      cam = await cameraOf(agent.identity.agentId);
    });
    const asked = () =>
      proxy.wire.filter((w) => w.dir === "api->agent" && w.text.includes("snapshot.request")).length;

    it("viewer and noc are refused before the agent is asked; an operator without a grant is refused and audited", async () => {
      const n = asked();
      expect((await snap(viewer, cam)).statusCode).toBe(403);
      expect((await snap(noc, cam)).statusCode).toBe(403);
      const res = await snap(operator, cam);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { code: string }).code).toBe("camera_not_granted");
      expect(asked()).toBe(n);
      const denied = await env.admin.query(
        `select meta from audit_log where actor_id = $1 and action = 'camera.snapshot.denied' and target = $2`,
        [operator.userId, cam],
      );
      expect(denied.rowCount).toBeGreaterThan(0);
    });

    it("an operate grant opens it, a view grant does not, revoking closes it again", async () => {
      await giveAccess(env, owner, operator.userId, "camera", cam, "view");
      expect((await snap(operator, cam)).statusCode).toBe(403);
      await env.admin.query(`delete from camera_grant where user_id = $1`, [operator.userId]);
      await giveAccess(env, owner, operator.userId, "camera", cam, "operate");
      expect((await snap(operator, cam)).statusCode).toBe(200);
      await env.admin.query(`delete from camera_grant where user_id = $1`, [operator.userId]);
      expect((await snap(operator, cam)).statusCode).toBe(403);
    });

    it("another tenant gets 404 and its own agent is never asked", async () => {
      const bSite = (await createSite(env, other)).id;
      const bAgent = await realAgent(other, bSite, "Agen Tenant B");
      const n = asked();
      expect((await snap(other, cam)).statusCode).toBe(404);
      expect(asked()).toBe(n);
      expect(bAgent.client.state).toBe("ready");
    });

    it("is throttled like the direct path", async () => {
      const limited = await createTestEnv({
        RATE_LIMIT_SNAPSHOT_PER_MIN: "2",
        AGENT_SNAPSHOT_TIMEOUT_MS: "300",
      });
      try {
        const t = await createTenant(limited, "as-rl");
        const site = (await createSite(limited, t)).id;
        const enr = (
          (
            await limited.built.app.inject({
              method: "POST",
              url: `/v1/sites/${site}/enrollments`,
              headers: { cookie: t.cookie },
              payload: {},
            })
          ).json() as { token: string }
        ).token;
        const e = (
          await limited.built.app.inject({
            method: "POST",
            url: "/v1/agent/enroll",
            headers: { authorization: `Enroll ${enr}` },
            payload: { name: "x", publicKey: newAgentPublicKey() },
          })
        ).json() as { agentId: string; agentToken: string };
        const lu = await limited.listen();
        const fa = await fakeAgent(lu.wsUrl, e.agentToken, () => ({
          ok: true,
          jpegBase64: jpeg(100).toString("base64"),
        }));
        const camId = (
          await limited.admin.query(
            `select c.id from camera c join device d on d.id = c.device_id where d.agent_id = $1`,
            [e.agentId],
          )
        ).rows[0].id as string;
        const codes: number[] = [];
        for (let i = 0; i < 4; i++)
          codes.push(
            (
              await limited.built.app.inject({
                method: "POST",
                url: `/v1/cameras/${camId}/snapshot`,
                headers: { cookie: t.cookie },
              })
            ).statusCode,
          );
        expect(codes).toEqual([200, 200, 429, 429]);
        expect(fa.seen.filter((f) => f.type === "snapshot.request")).toHaveLength(2);
        fa.close();
      } finally {
        await limited.close();
      }
    });
  });

  describe("when the agent cannot deliver", () => {
    async function scripted(reply: Parameters<typeof fakeAgent>[2]) {
      const e = await enrollRaw(owner, siteId);
      const fa = await fakeAgent(wsUrl, e.agentToken, reply);
      stops.push(fa.close);
      await until(
        async () =>
          (await env.admin.query(`select 1 from device where agent_id = $1`, [e.agentId])).rowCount === 1,
      );
      return { ...fa, cam: await cameraOf(e.agentId), agentId: e.agentId };
    }
    const failure = async (r: { statusCode: number; json: () => unknown }) => ({
      status: r.statusCode,
      code: (r.json() as { code: string }).code,
    });

    it("an offline agent is 503 agent_offline and the attempt is audited", async () => {
      const s = await scripted(() => null);
      s.close();
      await until(() => !env.built.hub.isOnline(s.agentId));
      expect(await failure(await snap(owner, s.cam))).toEqual({ status: 503, code: "agent_offline" });
      const a = await env.admin.query(
        `select meta from audit_log where action = 'camera.snapshot.failed' and target = $1`,
        [s.cam],
      );
      expect(a.rows[0].meta).toMatchObject({ reason: "agent_offline", via: "agent" });
    });

    it("an agent that stays silent is 504 agent_timeout within the deadline", async () => {
      const s = await scripted(() => null);
      const started = Date.now();
      expect(await failure(await snap(owner, s.cam))).toEqual({ status: 504, code: "agent_timeout" });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("device errors reported by the agent keep their meaning", async () => {
      const cases: [string, number][] = [
        ["device_auth_failed", 422],
        ["device_timeout", 504],
        ["device_unreachable", 502],
        ["snapshot_invalid_image", 502],
        ["unsupported", 502],
      ];
      for (const [code, status] of cases) {
        const s = await scripted(() => ({ ok: false, code }));
        const got = await failure(await snap(owner, s.cam));
        expect(got.status, code).toBe(status);
        expect(got.code, code).toBe(code === "unsupported" ? "agent_snapshot_failed" : code);
      }
    });

    it("an image that is not a JPEG, or is empty, is refused even though the agent said ok", async () => {
      for (const body of [
        Buffer.from("<html>not a jpeg</html>"),
        Buffer.alloc(0),
        Buffer.from([0xff, 0xd8, 0x00, 0x00]),
      ]) {
        const s = await scripted(() => ({ ok: true, jpegBase64: body.toString("base64") }));
        const got = await failure(await snap(owner, s.cam));
        expect(got, String(body.length)).toEqual({ status: 502, code: "snapshot_invalid_image" });
      }
    });

    it("a camera the agent no longer reports is 409, not a silent timeout", async () => {
      const s = await scripted(() => ({ ok: true, jpegBase64: jpeg(100).toString("base64") }));
      await env.admin.query(`update camera set status = 'missing' where id = $1`, [s.cam]);
      expect(await failure(await snap(owner, s.cam))).toEqual({ status: 409, code: "camera_missing" });
      expect(s.seen.filter((f) => f.type === "snapshot.request")).toHaveLength(0);
    });

    it("a late or unsolicited result is not treated as an answer", async () => {
      const s = await scripted(() => null);
      s.ws.send(
        JSON.stringify({
          id: "nobody-asked",
          type: "snapshot.request.result",
          ts: new Date().toISOString(),
          payload: { ok: true, jpegBase64: jpeg(100).toString("base64") },
        }),
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(await failure(await snap(owner, s.cam))).toEqual({ status: 504, code: "agent_timeout" });
    });
  });

  it("2FA is required for video on the agent path too", async () => {
    const strict = await createTestEnv({ REQUIRE_2FA_FOR_VIDEO: "true", AGENT_SNAPSHOT_TIMEOUT_MS: "300" });
    try {
      const t = await createTenant(strict, "as-2fa");
      const site = (await createSite(strict, t)).id;
      const enr = (
        (
          await strict.built.app.inject({
            method: "POST",
            url: `/v1/sites/${site}/enrollments`,
            headers: { cookie: t.cookie },
            payload: {},
          })
        ).json() as { token: string }
      ).token;
      const e = (
        await strict.built.app.inject({
          method: "POST",
          url: "/v1/agent/enroll",
          headers: { authorization: `Enroll ${enr}` },
          payload: { name: "x", publicKey: newAgentPublicKey() },
        })
      ).json() as { agentId: string; agentToken: string };
      const su = await strict.listen();
      const fa = await fakeAgent(su.wsUrl, e.agentToken, () => ({
        ok: true,
        jpegBase64: jpeg(100).toString("base64"),
      }));
      const camId = (
        await strict.admin.query(
          `select c.id from camera c join device d on d.id = c.device_id where d.agent_id = $1`,
          [e.agentId],
        )
      ).rows[0].id as string;
      const res = await strict.built.app.inject({
        method: "POST",
        url: `/v1/cameras/${camId}/snapshot`,
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { code: string }).code).toBe("two_factor_required");
      expect(fa.seen.filter((f) => f.type === "snapshot.request")).toHaveLength(0);
      expect(USER_PASSWORD.length).toBeGreaterThan(0);
      fa.close();
    } finally {
      await strict.close();
    }
  });
});

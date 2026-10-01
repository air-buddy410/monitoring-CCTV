import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Agent, createLogger } from "@pantau/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  createSite,
  createTenant,
  createTestEnv,
  DEVICE_PASSWORD,
  DEVICE_USERNAME,
  type Tenant,
  type TestEnv,
} from "../helpers";

interface Wire {
  dir: "agent->api" | "api->agent";
  text: string;
}

/** A recording WebSocket relay between the agent and the API: what it sees is what is on the wire. */
async function recordingProxy(apiWsUrl: string) {
  const wire: Wire[] = [];
  const upgradeAuth: string[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const upstreams = new Set<WebSocket>();
  http.on("upgrade", (req, socket, head) => {
    upgradeAuth.push(req.headers.authorization ?? "");
    const up = new WebSocket(`${apiWsUrl}${req.url}`, {
      headers: { authorization: req.headers.authorization ?? "" },
    });
    upstreams.add(up);
    up.on("unexpected-response", (_r, res) => {
      socket.write(`HTTP/1.1 ${res.statusCode} X\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
    });
    up.on("error", () => socket.destroy());
    up.on("open", () => {
      wss.handleUpgrade(req, socket, head, (down) => {
        down.on("message", (d, bin) => {
          wire.push({ dir: "agent->api", text: d.toString() });
          up.send(d, { binary: bin });
        });
        up.on("message", (d, bin) => {
          wire.push({ dir: "api->agent", text: d.toString() });
          down.send(d, { binary: bin });
        });
        down.on("close", (c) => up.close(c >= 1000 && c < 5000 && c !== 1005 && c !== 1006 ? c : 1000));
        up.on("close", (c) => down.close(c >= 1000 && c < 5000 && c !== 1005 && c !== 1006 ? c : 1000));
      });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return {
    wire,
    upgradeAuth,
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
    async stop() {
      for (const u of upstreams) u.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

describe("agent end to end against the real API and a simulated ONVIF device (labelled Simulasi)", () => {
  let env: TestEnv;
  let owner: Tenant;
  let siteId: string;
  let httpUrl: string;
  let wsUrl: string;
  let proxy: Awaited<ReturnType<typeof recordingProxy>>;
  const agents: Agent[] = [];
  const agentLogs: string[] = [];
  const agentLogStream = new Writable({
    write(chunk, _e, cb) {
      agentLogs.push(chunk.toString());
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
  const enrollToken = async () =>
    (
      (
        await env.built.app.inject({
          method: "POST",
          url: `/v1/sites/${siteId}/enrollments`,
          headers: { cookie: owner.cookie },
          payload: {},
        })
      ).json() as { token: string }
    ).token;
  const dir = () => mkdtempSync(join(tmpdir(), "pantau-agent-e2e-"));
  const fast = {
    statusIntervalMs: 80,
    pingIntervalMs: 200,
    pongTimeoutMs: 500,
    ackTimeoutMs: 1500,
    backoff: () => 30,
  };

  async function launch(over: { dataDir?: string; name?: string } = {}) {
    const dataDir = over.dataDir ?? dir();
    const agent = await Agent.enroll({
      apiUrl: httpUrl,
      wsUrl: proxy.url,
      enrollToken: await enrollToken(),
      dataDir,
      name: over.name ?? "Agen E2E",
      allowLoopback: true,
      allowInsecure: true,
      logger: createLogger("debug", agentLogStream),
      client: fast,
    });
    agents.push(agent);
    return { agent, dataDir };
  }

  beforeAll(async () => {
    env = await createTestEnv();
    const u = await env.listen();
    httpUrl = u.httpUrl;
    wsUrl = u.wsUrl;
    proxy = await recordingProxy(wsUrl);
    owner = await createTenant(env, "e2e-owner");
    siteId = (await createSite(env, owner)).id;
  });
  afterAll(async () => {
    await Promise.all(agents.map((a) => a.stop()));
    await proxy.stop();
    await env.close();
  });

  it("enrolls, connects, discovers a Simulasi device, syncs metadata, reports status; credentials stay on the agent", async () => {
    const mock = await env.startMock({ channels: 2 });
    const { agent, dataDir } = await launch();
    agent.start();
    expect(await until(() => agent.client.state === "ready")).toBe(true);
    const id = agent.identity.agentId;
    expect(env.built.hub.isOnline(id)).toBe(true);
    expect(
      (
        (
          await env.built.app.inject({
            method: "GET",
            url: `/v1/agents/${id}`,
            headers: { cookie: owner.cookie },
          })
        ).json() as { status: string }
      ).status,
    ).toBe("online");

    const local = await agent.addDevice({
      name: "NVR Simulasi",
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    expect(local.cameras).toHaveLength(2);
    expect(mock.requests().length).toBeGreaterThan(0);

    // metadata reached the cloud, owned by this agent, without any stored credential
    expect(
      await until(
        async () =>
          (await env.admin.query(`select count(*)::int as n from device where agent_id = $1`, [id])).rows[0]
            .n === 1,
      ),
    ).toBe(true);
    const dev = (
      await env.admin.query(
        `select id, name, brand, model, host, port, site_id from device where agent_id = $1`,
        [id],
      )
    ).rows[0];
    expect(dev).toMatchObject({
      name: "NVR Simulasi",
      host: mock.host,
      port: mock.port,
      site_id: siteId,
      brand: "mockvendor",
    });
    expect(
      (await env.admin.query(`select count(*)::int as n from camera where device_id = $1`, [dev.id])).rows[0]
        .n,
    ).toBe(2);
    expect(
      (await env.admin.query(`select count(*)::int as n from device_secret where device_id = $1`, [dev.id]))
        .rows[0].n,
    ).toBe(0);

    // status reports camera liveness: the simulator is up, so its cameras come online
    expect(
      await until(
        async () =>
          (
            await env.admin.query(
              `select count(*)::int as n from camera where device_id = $1 and status = 'online'`,
              [dev.id],
            )
          ).rows[0].n === 2,
      ),
    ).toBe(true);
    const detail = (
      await env.built.app.inject({
        method: "GET",
        url: `/v1/agents/${id}`,
        headers: { cookie: owner.cookie },
      })
    ).json() as { lastStatus: { camerasOnline: number; camerasTotal: number; cpuPercent: number } };
    expect(detail.lastStatus).toMatchObject({ camerasOnline: 2, camerasTotal: 2 });
    expect(detail.lastStatus.cpuPercent).toBeGreaterThanOrEqual(0);

    // the simulator goes away: the next status reports the cameras offline
    await mock.stop();
    expect(
      await until(
        async () =>
          (
            await env.admin.query(
              `select count(*)::int as n from camera where device_id = $1 and status = 'offline'`,
              [dev.id],
            )
          ).rows[0].n === 2,
        8000,
      ),
    ).toBe(true);

    // ---- the sentinel scan: the device password and user name are nowhere they must not be ----
    const scan = (label: string, text: string) => {
      expect(text.includes(DEVICE_PASSWORD), `${label} contains the device password`).toBe(false);
      expect(text.includes(DEVICE_USERNAME), `${label} contains the device user name`).toBe(false);
    };
    const tables = (
      await env.admin.query(`select tablename from pg_tables where schemaname = 'public'`)
    ).rows.map((r) => r.tablename as string);
    for (const t of tables) {
      const hit = await env.admin.query(
        `select count(*)::int as n from "${t}" x where x::text like $1 or x::text like $2`,
        [`%${DEVICE_PASSWORD}%`, `%${DEVICE_USERNAME}%`],
      );
      // device_secret holds the direct-path interim vault (AES blobs), which never matches the plaintext either
      expect(hit.rows[0].n, `table ${t}`).toBe(0);
    }
    scan("API logs", env.logs.join("\n"));
    scan("agent logs", agentLogs.join("\n"));
    expect(proxy.wire.length).toBeGreaterThan(4);
    scan("WebSocket frames", proxy.wire.map((w) => w.text).join("\n"));
    for (const f of readdirSync(dataDir)) {
      if (!statSync(join(dataDir, f)).isFile()) continue;
      scan(`agent file ${f}`, readFileSync(join(dataDir, f), "utf8"));
    }
    for (const f of readdirSync(join(dataDir, "vault")))
      scan(`vault file ${f}`, readFileSync(join(dataDir, "vault", f), "utf8"));

    // ...yet the agent itself can still use them
    expect(agent.registry.credentialsFor(local.deviceKey)).toEqual({
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    // and no frame the agent sent has anything but metadata types
    const types = new Set(
      proxy.wire
        .filter((w) => w.dir === "agent->api")
        .map((w) => (JSON.parse(w.text) as { type: string }).type),
    );
    expect([...types].sort()).toEqual(["hello", "inventory.sync", "status"]);
    // the tokens are not on the wire either
    const token = agent.identity.agentToken;
    expect(proxy.wire.map((w) => w.text).join("\n")).not.toContain(token);
    expect(env.logs.join("\n")).not.toContain(token);
    expect(agentLogs.join("\n")).not.toContain(token);
  });

  it("agent files are private: 0600 files, 0700 data directory", async () => {
    const { agent, dataDir } = await launch({ name: "Agen Izin" });
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    for (const f of ["identity.json", "agent.key"]) expect(mode(join(dataDir, f)), f).toBe(0o600);
    agent.start();
    await until(() => agent.client.state === "ready");
    expect(mode(join(dataDir, "vault", "vault.key"))).toBe(0o600);
    await agent.stop();
  });

  it("after a drop the agent reconnects by itself and re-syncs without duplicating anything", async () => {
    const mock = await env.startMock({ channels: 1 });
    const { agent } = await launch({ name: "Agen Sambung" });
    agent.start();
    await until(() => agent.client.state === "ready");
    await agent.addDevice({
      name: "IPC Simulasi",
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    const id = agent.identity.agentId;
    await until(
      async () =>
        (await env.admin.query(`select count(*)::int as n from device where agent_id = $1`, [id])).rows[0]
          .n === 1,
    );

    let reconnects = 0;
    agent.client.on("ready", () => reconnects++);
    env.built.hub.disconnect(id, 1012, "restart");
    expect(await until(() => reconnects >= 1 && env.built.hub.isOnline(id))).toBe(true);
    expect(
      (await env.admin.query(`select count(*)::int as n from device where agent_id = $1`, [id])).rows[0].n,
    ).toBe(1);
    expect(
      (
        await env.admin.query(
          `select count(*)::int as n from camera c join device d on d.id = c.device_id where d.agent_id = $1`,
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await env.admin.query(`select status from agent where id = $1`, [id])).rows[0].status).toBe(
      "online",
    );
    await mock.stop();
    await agent.stop();
    expect(
      await until(
        async () =>
          (await env.admin.query(`select status from agent where id = $1`, [id])).rows[0].status ===
          "offline",
      ),
    ).toBe(true);
  });

  it("a restarted agent process keeps its identity and its credentials", async () => {
    const mock = await env.startMock({ channels: 1 });
    const { agent, dataDir } = await launch({ name: "Agen Mulai Ulang" });
    agent.start();
    await until(() => agent.client.state === "ready");
    const local = await agent.addDevice({
      name: "IPC",
      host: mock.host,
      port: mock.port,
      username: DEVICE_USERNAME,
      password: DEVICE_PASSWORD,
    });
    await agent.stop();
    const again = Agent.load({
      apiUrl: httpUrl,
      wsUrl: proxy.url,
      dataDir,
      allowLoopback: true,
      allowInsecure: true,
      logger: createLogger("debug", agentLogStream),
      client: fast,
    });
    agents.push(again);
    expect(again.identity.agentId).toBe(agent.identity.agentId);
    expect(again.registry.list().map((d) => d.deviceKey)).toEqual([local.deviceKey]);
    again.start();
    expect(await until(() => again.client.state === "ready")).toBe(true);
    await again.stop();
    await mock.stop();
  });

  it("NEGATIVE: a wrong token is refused, the agent reports it and stops retrying; nothing is created", async () => {
    const { agent, dataDir } = await launch({ name: "Agen Salah" });
    const before = (await env.admin.query(`select count(*)::int as n from agent`)).rows[0].n;
    const id = JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf8")) as { agentToken: string };
    const bad = Agent.load({
      apiUrl: httpUrl,
      wsUrl: proxy.url,
      dataDir: patchedCopy(dataDir, { agentToken: "pat_" + "Z".repeat(43) }),
      allowLoopback: true,
      allowInsecure: true,
      logger: createLogger("debug", agentLogStream),
      client: fast,
    });
    agents.push(bad);
    let unauthorized = 0;
    bad.client.on("unauthorized", () => unauthorized++);
    bad.start();
    expect(await until(() => unauthorized === 1)).toBe(true);
    expect(bad.client.state).toBe("unauthorized");
    // exactly one handshake with the bad token, then silence
    await new Promise((r) => setTimeout(r, 300));
    expect(proxy.upgradeAuth.filter((a) => a.includes("Z".repeat(43)))).toHaveLength(1);
    expect((await env.admin.query(`select count(*)::int as n from agent`)).rows[0].n).toBe(before);
    expect(env.built.hub.isOnline(agent.identity.agentId)).toBe(false);
    expect(id.agentToken.startsWith("pat_")).toBe(true);
  });

  it("NEGATIVE: revoking an agent drops it at once and it never comes back, even though it keeps its token file", async () => {
    const { agent } = await launch({ name: "Agen Dicabut" });
    agent.start();
    await until(() => agent.client.state === "ready");
    let unauthorized = 0;
    agent.client.on("unauthorized", () => unauthorized++);
    await env.built.app.inject({
      method: "POST",
      url: `/v1/agents/${agent.identity.agentId}/revoke`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(await until(() => unauthorized === 1)).toBe(true);
    expect(agent.client.state).toBe("unauthorized");
    await new Promise((r) => setTimeout(r, 300));
    expect(env.built.hub.isOnline(agent.identity.agentId)).toBe(false);
    expect(
      (await env.admin.query(`select status from agent where id = $1`, [agent.identity.agentId])).rows[0]
        .status,
    ).toBe("revoked");
  });

  it("NEGATIVE: an enrollment token cannot be reused by a second agent", async () => {
    const token = await enrollToken();
    const first = await Agent.enroll({
      apiUrl: httpUrl,
      wsUrl: proxy.url,
      enrollToken: token,
      dataDir: dir(),
      name: "Pertama",
      allowLoopback: true,
      allowInsecure: true,
      logger: createLogger("silent", agentLogStream),
      client: fast,
    });
    agents.push(first);
    await expect(
      Agent.enroll({
        apiUrl: httpUrl,
        wsUrl: proxy.url,
        enrollToken: token,
        dataDir: dir(),
        name: "Kedua",
        allowLoopback: true,
        allowInsecure: true,
        logger: createLogger("silent", agentLogStream),
        client: fast,
      }),
    ).rejects.toMatchObject({ code: "enrollment_invalid" });
  });

  it("the command line: enroll, add-device and run work end to end and never print a token or a password", async () => {
    const { execFile, spawn } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const dataDir = dir();
    const mock = await env.startMock({ channels: 1 });
    const token = await enrollToken();
    const run = (args: string[], extra: Record<string, string>) =>
      exec("pnpm", ["--silent", "--filter", "@pantau/agent", "exec", "tsx", "src/main.ts", ...args], {
        env: {
          ...process.env,
          PANTAU_API_URL: httpUrl,
          PANTAU_AGENT_DATA_DIR: dataDir,
          PANTAU_ALLOW_LOOPBACK: "true",
          PANTAU_ALLOW_INSECURE: "true",
          PANTAU_LOG_LEVEL: "silent",
          ...extra,
        },
        timeout: 60_000,
      });
    const out1 = await run(["enroll"], { PANTAU_ENROLL_TOKEN: token, PANTAU_AGENT_NAME: "Agen CLI" });
    expect(out1.stdout).toMatch(/enrolled as agt_/);
    const out2 = await run(["add-device", "NVR CLI", mock.host, String(mock.port)], {
      PANTAU_DEVICE_USER: DEVICE_USERNAME,
      PANTAU_DEVICE_PASSWORD: DEVICE_PASSWORD,
    });
    expect(out2.stdout).toMatch(/added dev-/);
    // the one-time token is spent: enrolling again is refused
    await expect(run(["enroll"], { PANTAU_ENROLL_TOKEN: token })).rejects.toMatchObject({
      stderr: expect.stringContaining("already_enrolled"),
    });

    const child = spawn(
      "pnpm",
      ["--silent", "--filter", "@pantau/agent", "exec", "tsx", "src/main.ts", "run"],
      {
        env: {
          ...process.env,
          PANTAU_API_URL: httpUrl,
          PANTAU_AGENT_DATA_DIR: dataDir,
          PANTAU_ALLOW_LOOPBACK: "true",
          PANTAU_ALLOW_INSECURE: "true",
          PANTAU_LOG_LEVEL: "debug",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const agentId = (JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf8")) as { agentId: string })
      .agentId;
    const online = await until(() => env.built.hub.isOnline(agentId), 20_000);
    child.kill("SIGTERM");
    expect(online).toBe(true);
    const all = out1.stdout + out1.stderr + out2.stdout + out2.stderr + output;
    for (const secret of [
      DEVICE_PASSWORD,
      DEVICE_USERNAME,
      token,
      (JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf8")) as { agentToken: string }).agentToken,
    ]) {
      expect(all.includes(secret), "a secret was printed by the command line").toBe(false);
    }
    await mock.stop();
  });

  it("the agent refuses a plain ws:// or http:// API unless that is explicitly allowed", async () => {
    await expect(
      Agent.enroll({
        apiUrl: "http://api.example.test",
        enrollToken: "pae_" + "E".repeat(43),
        dataDir: dir(),
        name: "x",
        logger: createLogger("silent", agentLogStream),
      }),
    ).rejects.toMatchObject({ code: "insecure_api_url" });
  });
});

import { cpSync, writeFileSync } from "node:fs";

function patchedCopy(src: string, patch: Record<string, string>): string {
  const dst = mkdtempSync(join(tmpdir(), "pantau-agent-bad-"));
  cpSync(src, dst, { recursive: true });
  const id = JSON.parse(readFileSync(join(dst, "identity.json"), "utf8")) as Record<string, string>;
  writeFileSync(join(dst, "identity.json"), JSON.stringify({ ...id, ...patch }), { mode: 0o600 });
  return dst;
}

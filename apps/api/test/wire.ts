import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

export interface Wire {
  dir: "agent->api" | "api->agent";
  text: string;
}

/** A recording WebSocket relay between the agent and the API: what it sees is what is on the wire. */
export async function recordingProxy(apiWsUrl: string) {
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

export interface FakeAgentFrame {
  id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

/**
 * A scripted agent for failure-mode tests: it says hello, reports one device with one camera, and answers
 * snapshot requests with whatever the test chooses (or not at all).
 */
export async function fakeAgent(
  wsUrl: string,
  token: string,
  reply: (req: FakeAgentFrame) => Record<string, unknown> | null,
  device = { deviceKey: "dev-fake", channel: "1" },
) {
  const ws = new WebSocket(`${wsUrl}/agent`, { headers: { authorization: `Agent ${token}` } });
  const seen: FakeAgentFrame[] = [];
  const send = (type: string, payload: unknown, id: string) =>
    ws.send(JSON.stringify({ id, type, ts: new Date().toISOString(), payload }));
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString()) as FakeAgentFrame;
    seen.push(f);
    if (f.type === "snapshot.request") {
      const out = reply(f);
      if (out) send("snapshot.request.result", out, f.id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const waitAck = (id: string) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no ack")), 3000);
      const iv = setInterval(() => {
        if (seen.some((f) => f.type === "ack" && f.id === id)) {
          clearTimeout(t);
          clearInterval(iv);
          resolve();
        }
      }, 10);
    });
  send("hello", { agentVersion: "0.0.0-fake", go2rtcVersion: null, hostname: "fake" }, "h1");
  await waitAck("h1");
  send(
    "inventory.sync",
    {
      devices: [
        {
          deviceKey: device.deviceKey,
          name: "Simulasi Palsu",
          kind: "ipc",
          brand: "mockvendor",
          model: "FAKE",
          firmware: "0",
          adapterId: "onvif-generic",
          host: "192.168.1.77",
          port: 80,
          capabilities: { snapshot: "ya" },
          cameras: [
            { channel: device.channel, name: "Kamera Palsu", hasPtz: false, mainCodec: null, subCodec: null },
          ],
        },
      ],
    },
    "i1",
  );
  await waitAck("i1");
  return { ws, seen, close: () => ws.terminate() };
}

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { AgentHello, AgentInventorySync, AgentStatusReport, type AuditAction } from "@pantau/contracts";
import { agent, camera, device, newId, withTenant } from "@pantau/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type AgentConnection, parseEnvelope } from "../agent-hub";
import { hashAgentToken, parseAgentToken } from "../agent-token";
import type { Deps } from "../app";
import { writeAuditSystem } from "../audit";
import { acceptKey, type DecodedFrame, encodeClose, encodePong, encodeText, FrameDecoder } from "../ws-frame";

/** Heartbeat cadence from PRD section 9.2 (default 20 s). Two missed pings and the socket is dead. */
export const DEFAULT_HEARTBEAT_MS = 20_000;
const MAX_MISSED_HEARTBEATS = 2;
const UPGRADE_PATH = "/v1/agent/ws";

interface AgentRow {
  id: string;
  organizationId: string;
  siteId: string;
  status: string;
}

/**
 * Agent channel (PRD section 9.2). Authentication is `Authorization: Agent <token>`; the token embeds the
 * org and agent id and is verified against the stored SHA-256 hash, so a leaked database row cannot be
 * replayed as a credential. Agents only ever open outbound connections (PRD section A1), so this rides
 * the HTTP upgrade path rather than a listening port of its own.
 */
export function agentChannelRoutes(app: FastifyInstance, deps: Deps) {
  const { handle } = deps;

  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== UPGRADE_PATH) return; // anything else falls through to the normal 404

    const key = req.headers["sec-websocket-key"];
    if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const auth = req.headers.authorization ?? "";
    const parsed = parseAgentToken(
      auth.startsWith("Agent ") ? auth.slice("Agent ".length).trim() : undefined,
    );
    if (!parsed) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }

    // The handshake is not completed until the token is verified: an unauthenticated peer must never hold
    // a socket the hub would consider live. Verification happens inside the tenant transaction, so RLS
    // still constrains the lookup (no privileged read path exists for agent tokens).
    void (async () => {
      const row = await withTenant(handle.db, parsed.orgId, async (tx) => {
        const rows = await tx
          .select({
            id: agent.id,
            organizationId: agent.organizationId,
            siteId: agent.siteId,
            status: agent.status,
            tokenHash: agent.tokenHash,
          })
          .from(agent)
          .where(eq(agent.id, parsed.agentId))
          .limit(1);
        const found = rows[0];
        if (!found || found.tokenHash !== hashAgentToken(parsed)) {
          return null;
        }
        return found;
      });
      if (!row || row.status === "revoked") {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          "",
          "",
        ].join("\r\n"),
      );
      await runConnection({ app, deps, socket, head, row });
    })().catch((err: unknown) => {
      app.log.error({ errName: (err as Error).name }, "agent upgrade failed");
      socket.destroy();
    });
  });
}

async function runConnection(opts: {
  app: FastifyInstance;
  deps: Deps;
  socket: Duplex;
  head: Buffer;
  row: AgentRow;
}): Promise<void> {
  const { app, deps, socket, row } = opts;
  const { handle, hub } = deps;
  const log = app.log;

  let closed = false;
  let missedHeartbeats = 0;
  const decoder = new FrameDecoder();

  const conn: AgentConnection = {
    agentId: row.id,
    orgId: row.organizationId,
    siteId: row.siteId,
    send: (frame) => {
      if (closed) return false;
      socket.write(encodeText(frame));
      return true;
    },
    close: (code, reason) => {
      if (closed) return;
      closed = true;
      socket.write(encodeClose(code, reason));
      socket.end();
    },
  };

  const markOffline = () =>
    withTenant(handle.db, row.organizationId, (tx) =>
      tx.update(agent).set({ status: "offline", lastSeenAt: new Date() }).where(eq(agent.id, row.id)),
    ).catch(() => undefined);

  const shutdown = async (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    socket.write(encodeClose(code, reason));
    socket.end();
    hub.detach(conn);
    await markOffline();
  };

  const handleFrame = async (frame: DecodedFrame) => {
    if (frame.kind === "protocol-error") {
      log.warn({ agentId: row.id, reason: frame.reason }, "agent protocol error");
      await shutdown(frame.closeCode, frame.reason);
      return;
    }
    if (frame.kind === "close") {
      await shutdown(1000, "client closed");
      return;
    }
    if (frame.kind === "ping") {
      socket.write(encodePong(frame.payload));
      return;
    }
    if (frame.kind === "pong") {
      missedHeartbeats = 0;
      return;
    }

    const envelope = parseEnvelope(frame.text);
    if (!envelope) {
      conn.send(errorFrame("server", "invalid_envelope"));
      return;
    }
    // Any reply carrying a request id settles the waiting caller (PRD section 9.2).
    if (hub.settle(envelope)) return;

    switch (envelope.type) {
      case "hello": {
        const parsed = AgentHello.safeParse(envelope.payload);
        if (!parsed.success) return void conn.send(errorFrame(envelope.id, "invalid_hello"));
        await withTenant(handle.db, row.organizationId, (tx) =>
          tx.update(agent).set({ version: parsed.data.version }).where(eq(agent.id, row.id)),
        );
        conn.send(
          JSON.stringify({
            id: envelope.id,
            type: "hello.ack",
            ts: new Date().toISOString(),
            payload: { agentId: row.id, siteId: row.siteId, heartbeatMs: deps.config.agentHeartbeatMs },
          }),
        );
        return;
      }
      case "inventory.sync": {
        const parsed = AgentInventorySync.safeParse(envelope.payload);
        if (!parsed.success) return void conn.send(errorFrame(envelope.id, "invalid_inventory"));
        const counts = await applyInventory(deps, row, parsed.data);
        conn.send(
          JSON.stringify({
            id: envelope.id,
            type: "inventory.ack",
            ts: new Date().toISOString(),
            payload: counts,
          }),
        );
        return;
      }
      case "status": {
        const parsed = AgentStatusReport.safeParse(envelope.payload);
        if (!parsed.success) return void conn.send(errorFrame(envelope.id, "invalid_status"));
        await applyStatus(deps, row, parsed.data);
        return;
      }
      case "event.motion": {
        // M4 owns motion events end to end. The channel records that the frame arrived (without storing a
        // thumbnail) so an agent is not disconnected for a feature the cloud cannot yet persist.
        await withTenant(handle.db, row.organizationId, (tx) =>
          writeAuditSystem(tx, row.organizationId, null, "agent.event.received", row.id, {
            accepted: false,
            reason: "m4_not_implemented",
          }),
        );
        return;
      }
      default:
        conn.send(errorFrame(envelope.id, "unsupported_type"));
    }
  };

  const onData = (chunk: Buffer) => {
    void (async () => {
      for (const frame of decoder.push(chunk)) await handleFrame(frame);
    })().catch((err: unknown) => {
      log.error({ agentId: row.id, errName: (err as Error).name }, "agent frame handler failed");
      void shutdown(1011, "internal error");
    });
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
      void shutdown(1001, "heartbeat timeout");
      return;
    }
    missedHeartbeats += 1;
    conn.send(JSON.stringify({ id: "hb", type: "ping", ts: new Date().toISOString(), payload: {} }));
  }, deps.config.agentHeartbeatMs);
  heartbeat.unref?.();

  socket.on("data", onData);
  // A field agent can vanish without a close handshake (power cut, NAT timeout, LTE drop). Node reports
  // that as "end" with the socket still half-open, so without this the agent would stay "online" forever.
  socket.on("end", () => void shutdown(1000, "peer closed the connection"));
  socket.on("error", () => void shutdown(1011, "socket error"));
  socket.on("close", () => {
    clearInterval(heartbeat);
    closed = true;
    hub.detach(conn);
    void markOffline();
  });

  hub.attach(conn);
  if (opts.head?.length) onData(opts.head);

  if (!closed) {
    await withTenant(handle.db, row.organizationId, (tx) =>
      tx.update(agent).set({ status: "online", lastSeenAt: new Date() }).where(eq(agent.id, row.id)),
    );
    // the socket may have died while that write was in flight; do not leave it recorded as online
    if (closed) await markOffline();
  }
}

const errorFrame = (id: string, code: string) =>
  JSON.stringify({ id, type: "error", ts: new Date().toISOString(), payload: { code } });

async function applyInventory(
  deps: Deps,
  row: AgentRow,
  inventory: AgentInventorySync,
): Promise<{ devices: number; cameras: number }> {
  let cameraCount = 0;
  await withTenant(deps.handle.db, row.organizationId, async (tx) => {
    for (const d of inventory.devices) {
      const existing = await tx
        .select({ id: device.id })
        .from(device)
        .where(
          and(
            eq(device.siteId, row.siteId),
            eq(device.host, d.host),
            eq(device.port, d.port),
            eq(device.agentId, row.id),
          ),
        )
        .limit(1);
      const deviceId = existing[0]?.id ?? newId("dev");
      if (existing[0]) {
        await tx
          .update(device)
          .set({
            name: d.name,
            kind: d.kind,
            brand: d.brand,
            model: d.model,
            firmware: d.firmware,
            adapterId: d.adapterId,
            capabilities: d.capabilities ?? {},
            status: d.status,
          })
          .where(eq(device.id, deviceId));
      } else {
        await tx.insert(device).values({
          id: deviceId,
          organizationId: row.organizationId,
          siteId: row.siteId,
          agentId: row.id,
          name: d.name,
          kind: d.kind,
          brand: d.brand,
          model: d.model,
          firmware: d.firmware,
          adapterId: d.adapterId,
          host: d.host,
          port: d.port,
          capabilities: d.capabilities ?? {},
          status: d.status,
        });
      }
      for (const c of d.cameras) {
        cameraCount += 1;
        const found = await tx
          .select({ id: camera.id })
          .from(camera)
          .where(and(eq(camera.deviceId, deviceId), eq(camera.channel, c.channel)))
          .limit(1);
        const values = {
          name: c.name,
          hasPtz: c.hasPtz,
          mainCodec: c.mainCodec ?? null,
          subCodec: c.subCodec ?? null,
          status: c.status,
          sortOrder: c.sortOrder,
        };
        if (found[0]) {
          await tx.update(camera).set(values).where(eq(camera.id, found[0].id));
        } else {
          await tx.insert(camera).values({
            id: newId("cam"),
            organizationId: row.organizationId,
            deviceId,
            channel: c.channel,
            ...values,
          });
        }
      }
    }
    await writeAuditSystem(
      tx,
      row.organizationId,
      null,
      "agent.inventory.sync" satisfies AuditAction,
      row.id,
      { devices: inventory.devices.length, cameras: cameraCount },
    );
  });
  return { devices: inventory.devices.length, cameras: cameraCount };
}

async function applyStatus(deps: Deps, row: AgentRow, report: AgentStatusReport): Promise<void> {
  await withTenant(deps.handle.db, row.organizationId, async (tx) => {
    await tx.update(agent).set({ status: "online", lastSeenAt: new Date() }).where(eq(agent.id, row.id));
    // status carries the agent's own device key, so resolve it to the devices this agent owns
    for (const c of report.cameras) {
      const owned = await tx
        .select({ id: device.id })
        .from(device)
        .where(and(eq(device.agentId, row.id), eq(device.host, c.deviceKey)))
        .limit(1);
      if (!owned[0]) continue;
      await tx
        .update(camera)
        .set({ status: c.status })
        .where(and(eq(camera.deviceId, owned[0].id), eq(camera.channel, c.channel)));
    }
  });
}

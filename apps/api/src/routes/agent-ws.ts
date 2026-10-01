import websocket from "@fastify/websocket";
import {
  AgentInbound,
  containsForbiddenKey,
  type Envelope,
  frameLimitFor,
  type InventorySync,
  MAX_SNAPSHOT_FRAME_BYTES,
  parseEnvelope,
  type StatusReport,
} from "@pantau/contracts";
import { agent, camera, device, enterTenant, newId, withTenant, withTokenHash } from "@pantau/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import type { Deps } from "../app";
import { writeAuditSystem } from "../audit";
import { AppError } from "../errors";
import { bearerOf, hashToken } from "../tokens";

interface AgentCtx {
  agentId: string;
  orgId: string;
  siteId: string;
}
declare module "fastify" {
  interface FastifyRequest {
    agentCtx?: AgentCtx;
  }
}

const MAX_INVALID_IN_A_ROW = 5;
const unauthorized = () => new AppError(401, "agent_unauthorized", "Agent token is invalid or revoked");

/** Same-process registry of live agents; see AgentHub. Frames carry metadata only (packages/contracts/src/agent.ts). */
export async function agentWsRoutes(app: FastifyInstance, deps: Deps) {
  const { handle, hub, config } = deps;
  await app.register(websocket, { options: { maxPayload: MAX_SNAPSHOT_FRAME_BYTES } });

  /** Runs before the upgrade, so a bad token never gets a socket. */
  const authenticate = async (req: FastifyRequest) => {
    const token = bearerOf(req.headers.authorization, "Agent", "agent");
    if (!token) throw unauthorized();
    const row = await withTokenHash(handle.db, hashToken(token), async (tx) => {
      const [a] = await tx
        .select({
          id: agent.id,
          orgId: agent.organizationId,
          siteId: agent.siteId,
          revokedAt: agent.revokedAt,
        })
        .from(agent)
        .limit(1);
      return a;
    });
    if (!row || row.revokedAt) throw unauthorized();
    req.agentCtx = { agentId: row.id, orgId: row.orgId, siteId: row.siteId };
  };

  app.get("/agent", { websocket: true, onRequest: authenticate, schema: { hide: true } }, (socket, req) => {
    const ctx = req.agentCtx as AgentCtx;
    serve(socket, ctx, req);
  });

  function serve(socket: WebSocket, ctx: AgentCtx, req: FastifyRequest) {
    const log = req.log;
    hub.add(ctx.agentId, ctx.orgId, socket);
    let helloDone = false;
    let invalidStreak = 0;
    let alive = true;
    let windowStart = Date.now();
    let inWindow = 0;
    let queue: Promise<void> = Promise.resolve();

    void withTenant(handle.db, ctx.orgId, (tx) =>
      tx
        .update(agent)
        .set({ status: "online", lastSeenAt: new Date() })
        .where(and(eq(agent.id, ctx.agentId), ne(agent.status, "revoked"))),
    ).catch((e) => log.error({ errName: (e as Error).name }, "agent presence update failed"));

    const send = (type: "ack" | "error", id: string, payload: Record<string, unknown>) => {
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ id, type, ts: new Date().toISOString(), payload }));
    };
    const refuse = (id: string, code: string, message: string) => {
      invalidStreak++;
      send("error", id, { code, message });
      if (invalidStreak >= MAX_INVALID_IN_A_ROW) socket.close(1008, "too many invalid messages");
    };

    const ping = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, config.agentPingIntervalMs);
    socket.on("pong", () => {
      alive = true;
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      const now = Date.now();
      if (now - windowStart > 10_000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > config.agentMaxMessagesPer10s) {
        socket.close(1008, "rate limit");
        return;
      }
      // frames are handled one at a time, in order
      queue = queue
        .then(() => handle1(data, isBinary))
        .catch((e) => {
          log.error({ errName: (e as Error).name }, "agent frame handler failed");
          send("error", "-", { code: "internal_error", message: "internal error" });
        });
    });

    socket.on("close", () => {
      clearInterval(ping);
      if (!hub.remove(ctx.agentId, socket)) return;
      void withTenant(handle.db, ctx.orgId, (tx) =>
        tx
          .update(agent)
          .set({ status: "offline" })
          .where(and(eq(agent.id, ctx.agentId), ne(agent.status, "revoked"))),
      ).catch((e) => log.error({ errName: (e as Error).name }, "agent presence update failed"));
    });
    socket.on("error", () => socket.terminate());

    async function handle1(data: RawData, isBinary: boolean) {
      if (isBinary) return refuse("-", "invalid_message", "text frames only");
      const text = data.toString();
      const parsed = parseEnvelope(text, MAX_SNAPSHOT_FRAME_BYTES);
      if (!parsed.ok) return refuse("-", "invalid_message", parsed.reason);
      const env: Envelope = parsed.value;
      // only a snapshot result may be larger than an ordinary frame
      if (Buffer.byteLength(text) > frameLimitFor(env.type)) {
        socket.close(1009, "frame too large");
        return;
      }
      if (containsForbiddenKey(env.payload)) {
        log.warn({ agentId: ctx.agentId, type: env.type }, "agent frame carried a forbidden field");
        return refuse(env.id, "forbidden_field", "frame contains a field that agents must not send");
      }
      const msg = AgentInbound.safeParse(env);
      if (!msg.success) {
        const known = AgentInbound.options.some((o) => o.shape.type.value === env.type);
        if (!known) return refuse(env.id, "unsupported_type", "unknown message type");
        // paths only; submitted values may be sensitive
        const detail = msg.error.issues
          .map((i) => i.path.join(".") || "/")
          .slice(0, 5)
          .join(", ");
        return refuse(env.id, "invalid_payload", `invalid fields: ${detail}`.slice(0, 200));
      }
      const m = msg.data;
      if (m.type !== "hello" && !helloDone) return refuse(m.id, "hello_required", "send hello first");
      switch (m.type) {
        case "hello": {
          await withTenant(handle.db, ctx.orgId, (tx) =>
            tx
              .update(agent)
              .set({
                version: m.payload.agentVersion,
                go2rtcVersion: m.payload.go2rtcVersion,
                hostname: m.payload.hostname,
                status: "online",
                lastSeenAt: new Date(),
              })
              .where(and(eq(agent.id, ctx.agentId), ne(agent.status, "revoked"))),
          );
          helloDone = true;
          invalidStreak = 0;
          return send("ack", m.id, { serverTime: new Date().toISOString() });
        }
        case "inventory.sync": {
          const out = await syncInventory(handle, ctx, m.payload);
          invalidStreak = 0;
          return send("ack", m.id, out);
        }
        case "status": {
          await applyStatus(handle, ctx, m.payload);
          invalidStreak = 0;
          return;
        }
        case "ptz.command.result":
        case "snapshot.request.result": {
          if (!hub.settle(ctx.agentId, m.id, m.payload)) {
            return refuse(m.id, "unexpected_result", "no request is waiting for this id");
          }
          invalidStreak = 0;
          return;
        }
        default:
          // event.motion arrives in M4
          return refuse(m.id, "unsupported_type", "not handled by this server version");
      }
    }
  }
}

type Handle = Deps["handle"];

async function syncInventory(handle: Handle, ctx: AgentCtx, inv: InventorySync) {
  return withTenant(handle.db, ctx.orgId, async (tx) => {
    const existing = await tx.select().from(device).where(eq(device.agentId, ctx.agentId));
    const byKey = new Map(existing.map((d) => [d.agentDeviceKey as string, d]));
    const reported = new Set(inv.devices.map((d) => d.deviceKey));
    const result: { deviceKey: string; id: string; cameras: { channel: string; id: string }[] }[] = [];
    let created = 0;
    let missing = 0;

    for (const d of inv.devices) {
      const fields = {
        name: d.name,
        kind: d.kind,
        brand: d.brand,
        model: d.model,
        firmware: d.firmware,
        adapterId: d.adapterId,
        host: d.host,
        port: d.port,
        capabilities: d.capabilities,
      };
      let row = byKey.get(d.deviceKey);
      if (row) {
        const status = row.status === "missing" ? "unknown" : row.status;
        [row] = await tx
          .update(device)
          .set({ ...fields, status })
          .where(eq(device.id, row.id))
          .returning();
      } else {
        created++;
        [row] = await tx
          .insert(device)
          .values({
            id: newId("dev"),
            organizationId: ctx.orgId,
            siteId: ctx.siteId,
            agentId: ctx.agentId,
            agentDeviceKey: d.deviceKey,
            status: "unknown",
            ...fields,
          })
          .returning();
      }
      const dev = row as typeof device.$inferSelect;
      const cams = await tx.select().from(camera).where(eq(camera.deviceId, dev.id));
      const camByChannel = new Map(cams.map((c) => [c.channel, c]));
      const camOut: { channel: string; id: string }[] = [];
      let order = 0;
      for (const c of d.cameras) {
        const old = camByChannel.get(c.channel);
        if (old) {
          // name and position belong to the operator once the camera exists
          await tx
            .update(camera)
            .set({
              hasPtz: c.hasPtz,
              mainCodec: c.mainCodec,
              subCodec: c.subCodec,
              status: old.status === "missing" ? "unknown" : old.status,
            })
            .where(eq(camera.id, old.id));
          camOut.push({ channel: c.channel, id: old.id });
        } else {
          const id = newId("cam");
          await tx.insert(camera).values({
            id,
            organizationId: ctx.orgId,
            deviceId: dev.id,
            channel: c.channel,
            name: c.name,
            hasPtz: c.hasPtz,
            mainCodec: c.mainCodec,
            subCodec: c.subCodec,
            status: "unknown",
            sortOrder: order,
          });
          camOut.push({ channel: c.channel, id });
        }
        order++;
      }
      const gone = cams.filter((c) => !d.cameras.some((x) => x.channel === c.channel));
      if (gone.length) {
        missing += gone.length;
        await tx
          .update(camera)
          .set({ status: "missing" })
          .where(
            inArray(
              camera.id,
              gone.map((c) => c.id),
            ),
          );
      }
      result.push({ deviceKey: d.deviceKey, id: dev.id, cameras: camOut });
    }

    const goneDevices = existing.filter((d) => !reported.has(d.agentDeviceKey as string));
    if (goneDevices.length) {
      missing += goneDevices.length;
      const ids = goneDevices.map((d) => d.id);
      await tx.update(device).set({ status: "missing" }).where(inArray(device.id, ids));
      await tx.update(camera).set({ status: "missing" }).where(inArray(camera.deviceId, ids));
    }
    await tx.update(agent).set({ lastSeenAt: new Date() }).where(eq(agent.id, ctx.agentId));
    await writeAuditSystem(tx, ctx.orgId, null, "agent.inventory.sync", ctx.agentId, {
      devices: inv.devices.length,
      cameras: inv.devices.reduce((n, d) => n + d.cameras.length, 0),
      created,
      missing,
    });
    return { devices: result };
  });
}

async function applyStatus(handle: Handle, ctx: AgentCtx, s: StatusReport) {
  await withTenant(handle.db, ctx.orgId, async (tx) => {
    const devs = await tx
      .select({ id: device.id, key: device.agentDeviceKey })
      .from(device)
      .where(eq(device.agentId, ctx.agentId));
    const idOf = new Map(devs.map((d) => [d.key as string, d.id]));
    const online = new Map<string, string[]>();
    const offline = new Map<string, string[]>();
    for (const c of s.cameras) {
      const id = idOf.get(c.deviceKey);
      if (!id) continue;
      const bucket = c.online ? online : offline;
      bucket.set(id, [...(bucket.get(id) ?? []), c.channel]);
    }
    for (const [deviceId, channels] of online) {
      await tx
        .update(camera)
        .set({ status: "online" })
        .where(and(eq(camera.deviceId, deviceId), inArray(camera.channel, channels)));
    }
    for (const [deviceId, channels] of offline) {
      await tx
        .update(camera)
        .set({ status: "offline" })
        .where(and(eq(camera.deviceId, deviceId), inArray(camera.channel, channels)));
    }
    for (const deviceId of new Set([...online.keys(), ...offline.keys()])) {
      await tx
        .update(device)
        .set({ status: online.has(deviceId) ? "online" : "offline" })
        .where(eq(device.id, deviceId));
    }
    const known = s.cameras.filter((c) => idOf.has(c.deviceKey));
    await tx
      .update(agent)
      .set({
        lastSeenAt: new Date(),
        lastStatus: {
          cpuPercent: s.cpuPercent,
          memUsedPercent: s.memUsedPercent,
          diskUsedPercent: s.diskUsedPercent,
          ...(s.uptimeSec !== undefined ? { uptimeSec: s.uptimeSec } : {}),
          camerasOnline: known.filter((c) => c.online).length,
          camerasTotal: known.length,
          at: new Date().toISOString(),
        },
      })
      .where(eq(agent.id, ctx.agentId));
  });
}

import { randomUUID } from "node:crypto";
import { AdapterError, onvifGenericAdapter } from "@pantau/adapters";
import { type AdapterErrorCode, IdParams, SnapshotResult } from "@pantau/contracts";
import { camera, device, deviceSecret, withTenant } from "@pantau/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { cameraAccess } from "../access";
import { AgentOfflineError, AgentTimeoutError } from "../agent-hub";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { AppError, fromAdapterCode, notFound, rateLimited } from "../errors";
import { requireAny, type TenantContext } from "../tenant";
import { errorResponses } from "./shared";

export function snapshotRoutes(app: FastifyInstance, deps: Deps) {
  const { handle, resolveTenant, vault, config } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  interface AgentCamera {
    cameraId: string;
    channel: string;
    deviceId: string;
    agentId: string;
    agentDeviceKey: string;
    cameraStatus: string;
  }
  const KNOWN_DEVICE_CODES = new Set<string>([
    "device_auth_failed",
    "device_timeout",
    "device_unreachable",
    "device_protocol_error",
    "snapshot_channel_not_found",
    "snapshot_uri_host_mismatch",
    "snapshot_uri_port_not_allowed",
    "snapshot_invalid_image",
    "snapshot_failed",
  ]);
  const looksLikeJpeg = (b: Buffer) =>
    b.length >= 4 &&
    b[0] === 0xff &&
    b[1] === 0xd8 &&
    b[2] === 0xff &&
    b[b.length - 2] === 0xff &&
    b[b.length - 1] === 0xd9;

  /** Snapshot taken by the on-site agent: the cloud sends a device key and a channel, never an address or a credential. */
  const viaAgent = async (t: TenantContext, cam: AgentCamera, reply: FastifyReply) => {
    const audit = (action: "camera.snapshot" | "camera.snapshot.failed", meta: Record<string, unknown>) =>
      withTenant(handle.db, t.orgId, (tx) =>
        writeAudit(tx, t, action, cam.cameraId, {
          via: "agent",
          agentId: cam.agentId,
          deviceId: cam.deviceId,
          ...meta,
        }),
      );
    const fail = async (status: number, code: string, title: string): Promise<never> => {
      await audit("camera.snapshot.failed", { reason: code });
      throw new AppError(status, code, title);
    };
    if (cam.cameraStatus === "missing") {
      return fail(409, "camera_missing", "The agent no longer reports this camera");
    }
    let raw: Record<string, unknown>;
    try {
      raw = await deps.hub.request(
        cam.agentId,
        {
          id: randomUUID(),
          type: "snapshot.request",
          ts: new Date().toISOString(),
          payload: { deviceKey: cam.agentDeviceKey, channel: cam.channel },
        },
        config.agentSnapshotTimeoutMs,
      );
    } catch (e) {
      if (e instanceof AgentOfflineError)
        return fail(503, "agent_offline", "The site agent is not connected");
      if (e instanceof AgentTimeoutError)
        return fail(504, "agent_timeout", "The site agent did not answer in time");
      return fail(502, "agent_snapshot_failed", "The site agent could not take the snapshot");
    }
    const result = SnapshotResult.safeParse(raw);
    if (!result.success) return fail(502, "agent_snapshot_failed", "The site agent sent an unusable answer");
    if (!result.data.ok) {
      const code = result.data.code ?? "";
      if (code === "snapshot_too_large")
        return fail(502, code, "The snapshot is larger than the allowed size");
      if (KNOWN_DEVICE_CODES.has(code)) {
        const err = fromAdapterCode(code as AdapterErrorCode);
        await audit("camera.snapshot.failed", { reason: code });
        throw err;
      }
      return fail(502, "agent_snapshot_failed", "The site agent could not take the snapshot");
    }
    const jpeg = Buffer.from(result.data.jpegBase64 as string, "base64");
    if (!looksLikeJpeg(jpeg))
      return fail(502, "snapshot_invalid_image", "The agent did not return a valid JPEG");
    await audit("camera.snapshot", { bytes: jpeg.length });
    return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpeg);
  };

  r.post(
    "/v1/cameras/:id/snapshot",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["cameras"],
        summary: "Take a JPEG snapshot from a camera",
        description: "Responds with `image/jpeg` bytes. Every attempt is written to the audit log.",
        params: IdParams,
        response: { 200: z.any().describe("image/jpeg binary"), ...errorResponses },
      },
    },
    async (req, reply) => {
      // video roles only: noc manages onboarding and health but never watches (PRD section 2)
      const t = requireAny(req, ["owner", "operator"]);
      if (config.require2faForVideo && !t.twoFactor) {
        throw new AppError(403, "two_factor_required", "Two-factor authentication is required to view video");
      }
      const gate = deps.limiter.hit(`snapshot:${t.orgId}:${t.userId}`, config.rateLimit.snapshot);
      if (!gate.allowed) {
        await withTenant(handle.db, t.orgId, (tx) =>
          writeAudit(tx, t, "camera.snapshot.failed", req.params.id, { reason: "rate_limited" }),
        );
        throw rateLimited(gate.retryAfterSec);
      }

      const found = await withTenant(handle.db, t.orgId, async (tx) => {
        const rows = await tx
          .select({
            cameraId: camera.id,
            channel: camera.channel,
            siteId: device.siteId,
            deviceId: device.id,
            host: device.host,
            port: device.port,
            agentId: device.agentId,
            agentDeviceKey: device.agentDeviceKey,
            cameraStatus: camera.status,
            enc: deviceSecret.credentialsEnc,
          })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .leftJoin(deviceSecret, eq(deviceSecret.deviceId, device.id))
          .where(eq(camera.id, req.params.id))
          .limit(1);
        const row = rows[0];
        if (!row) return undefined;
        const decision = await cameraAccess(tx, t, { id: row.cameraId, siteId: row.siteId }, "operate");
        if (!decision.allowed) {
          await writeAudit(tx, t, "camera.snapshot.denied", row.cameraId, { reason: decision.reason });
          return decision;
        }
        return row;
      });
      if (!found) throw notFound("camera");
      if ("allowed" in found) {
        throw new AppError(403, "camera_not_granted", "You have no operate access to this camera");
      }

      if (found.agentId) {
        return viaAgent(t, found as AgentCamera, reply);
      }
      // direct path (interim, D1): only devices with a stored credential can be reached from the cloud
      if (!found.enc) throw notFound("camera");
      const creds = JSON.parse(vault.decrypt(found.enc)) as { u: string; p: string };
      try {
        const jpeg = await onvifGenericAdapter.snapshot(
          {
            host: found.host,
            port: found.port,
            username: creds.u,
            password: creds.p,
            timeoutMs: config.snapshotTimeoutMs,
          },
          found.channel,
        );
        await withTenant(handle.db, t.orgId, (tx) =>
          writeAudit(tx, t, "camera.snapshot", found.cameraId, {
            deviceId: found.deviceId,
            bytes: jpeg.length,
          }),
        );
        return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpeg);
      } catch (e) {
        const code = e instanceof AdapterError ? e.code : "snapshot_failed";
        await withTenant(handle.db, t.orgId, (tx) =>
          writeAudit(tx, t, "camera.snapshot.failed", found.cameraId, {
            deviceId: found.deviceId,
            reason: code,
          }),
        );
        throw fromAdapterCode(code);
      }
    },
  );
}

import { AdapterError, onvifGenericAdapter } from "@pantau/adapters";
import { IdParams } from "@pantau/contracts";
import { camera, device, deviceSecret, withTenant } from "@pantau/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { fromAdapterCode, notFound } from "../errors";
import { requireRole } from "../tenant";
import { errorResponses } from "./shared";

export function snapshotRoutes(app: FastifyInstance, deps: Deps) {
  const { handle, resolveTenant, vault, config } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

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
      const t = requireRole(req, "operator");

      const found = await withTenant(handle.db, t.orgId, async (tx) => {
        const rows = await tx
          .select({
            cameraId: camera.id,
            channel: camera.channel,
            deviceId: device.id,
            host: device.host,
            port: device.port,
            enc: deviceSecret.credentialsEnc,
          })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .innerJoin(deviceSecret, eq(deviceSecret.deviceId, device.id))
          .where(eq(camera.id, req.params.id))
          .limit(1);
        return rows[0];
      });
      if (!found) throw notFound("camera");

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

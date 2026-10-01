import { AdapterError, onvifGenericAdapter } from "@pantau/adapters";
import {
  CameraList,
  CameraPatch,
  DeviceCreate,
  DeviceList,
  DeviceWithCameras,
  IdParams,
  ListQuery,
  type ProbeResult,
} from "@pantau/contracts";
import { camera, device, deviceSecret, newId, site, withTenant } from "@pantau/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  cameraConfigAccess,
  cameraFilter,
  deviceFilter,
  siteAccess,
  siteFilter as siteVisible,
  visibleScope,
} from "../access";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { AppError, fromAdapterCode, notFound, rateLimited } from "../errors";
import { toCamera, toDevice } from "../mappers";
import { checkTarget } from "../target-policy";
import { requireRole } from "../tenant";
import { errorResponses } from "./shared";

export function deviceRoutes(app: FastifyInstance, deps: Deps) {
  const { handle, resolveTenant, vault, config } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/devices",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["devices"],
        summary: "Add a device manually, probe it (ONVIF, read-only) and create its cameras",
        description:
          "Credentials are used to probe and are stored encrypted (AES-256-GCM); they are never returned, logged or audited.",
        body: DeviceCreate,
        response: { 201: DeviceWithCameras, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireRole(req, "operator");
      const body = req.body;
      const gate = deps.limiter.hit(`probe:${t.orgId}:${t.userId}`, config.rateLimit.probe);

      const fail = async (err: AppError) => {
        await withTenant(handle.db, t.orgId, (tx) =>
          writeAudit(tx, t, "device.create.failed", null, {
            host: body.host,
            port: body.port,
            reason: err.code,
          }),
        );
        throw err;
      };

      if (!gate.allowed) return fail(rateLimited(gate.retryAfterSec));

      const policy = checkTarget(body.host, {
        allowLoopback: config.allowLoopbackTargets,
        allowCidrs: config.targetAllowCidrs,
      });
      if (!policy.allowed) {
        return fail(
          new AppError(422, "target_not_allowed", "This address cannot be used as a device target"),
        );
      }

      const siteCheck = await withTenant(handle.db, t.orgId, async (tx) => {
        const scope = await visibleScope(tx, t);
        const found = await tx
          .select({ id: site.id })
          .from(site)
          .where(and(eq(site.id, body.siteId), siteVisible(scope)))
          .limit(1);
        if (!found[0]) return "missing" as const;
        return (await siteAccess(tx, t, body.siteId)).allowed ? ("ok" as const) : ("denied" as const);
      });
      if (siteCheck === "missing") throw notFound("site");
      if (siteCheck === "denied")
        throw new AppError(403, "site_not_granted", "You have no operate access to this site");

      let probed: ProbeResult;
      try {
        probed = await onvifGenericAdapter.probe({
          host: body.host,
          port: body.port,
          username: body.username,
          password: body.password,
          timeoutMs: config.onvifTimeoutMs,
        });
      } catch (e) {
        const code = e instanceof AdapterError ? e.code : "device_protocol_error";
        return fail(fromAdapterCode(code));
      }
      if (probed.channels.length === 0) {
        return fail(new AppError(422, "device_no_channels", "Device reported no video channels"));
      }

      const deviceId = newId("dev");
      const encrypted = vault.encrypt(JSON.stringify({ u: body.username, p: body.password }));
      const result = await withTenant(handle.db, t.orgId, async (tx) => {
        const [dev] = await tx
          .insert(device)
          .values({
            id: deviceId,
            organizationId: t.orgId,
            siteId: body.siteId,
            name: body.name,
            kind: probed.channels.length > 1 ? "nvr" : "ipc",
            brand: probed.brand,
            model: probed.model,
            firmware: probed.firmware,
            adapterId: "onvif-generic",
            host: body.host,
            port: body.port,
            capabilities: probed.capabilities,
            status: "online",
          })
          .returning();
        await tx
          .insert(deviceSecret)
          .values({ deviceId, organizationId: t.orgId, credentialsEnc: encrypted });
        const cams = await tx
          .insert(camera)
          .values(
            probed.channels.map((c, i) => ({
              id: newId("cam"),
              organizationId: t.orgId,
              deviceId,
              channel: c.channel,
              name: c.name,
              hasPtz: c.hasPtz,
              mainCodec: c.mainCodec,
              subCodec: c.subCodec,
              status: "online",
              sortOrder: i,
            })),
          )
          .returning();
        await writeAudit(tx, t, "device.create", deviceId, {
          host: body.host,
          port: body.port,
          brand: probed.brand,
          model: probed.model,
          cameraCount: cams.length,
        });
        return { dev: dev as typeof device.$inferSelect, cams };
      });
      return reply.status(201).send({
        device: toDevice(result.dev),
        cameras: result.cams.map((c) => toCamera(c, body.siteId)),
      });
    },
  );

  r.get(
    "/v1/devices",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["devices"],
        summary: "List devices of the current tenant",
        querystring: ListQuery,
        response: { 200: DeviceList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const { siteId } = req.query;
      const rows = await withTenant(handle.db, t.orgId, async (tx) => {
        const scope = await visibleScope(tx, t);
        return tx
          .select()
          .from(device)
          .where(and(siteId ? eq(device.siteId, siteId) : undefined, deviceFilter(scope)))
          .orderBy(desc(device.createdAt));
      });
      return { items: rows.map(toDevice) };
    },
  );

  r.get(
    "/v1/devices/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["devices"],
        summary: "Get a device with its capabilities and cameras",
        params: IdParams,
        response: { 200: DeviceWithCameras, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const { dev, cams } = await withTenant(handle.db, t.orgId, async (tx) => {
        const scope = await visibleScope(tx, t);
        const [dev] = await tx
          .select()
          .from(device)
          .where(and(eq(device.id, req.params.id), deviceFilter(scope)))
          .limit(1);
        if (!dev) return { dev: undefined, cams: [] };
        // a camera-only grant shows that camera of the device, not its siblings
        const cams = await tx
          .select({ cam: camera })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(and(eq(camera.deviceId, dev.id), cameraFilter(scope)))
          .orderBy(asc(camera.sortOrder));
        return { dev, cams: cams.map((c) => c.cam) };
      });
      if (!dev) throw notFound("device");
      return { device: toDevice(dev), cameras: cams.map((c) => toCamera(c, dev.siteId)) };
    },
  );

  r.get(
    "/v1/cameras",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["cameras"],
        summary: "List cameras of the current tenant",
        querystring: ListQuery,
        response: { 200: CameraList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const { siteId } = req.query;
      const rows = await withTenant(handle.db, t.orgId, async (tx) => {
        const scope = await visibleScope(tx, t);
        return tx
          .select({ cam: camera, siteId: device.siteId })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(and(siteId ? eq(device.siteId, siteId) : undefined, cameraFilter(scope)))
          .orderBy(asc(camera.deviceId), asc(camera.sortOrder));
      });
      return { items: rows.map((x) => toCamera(x.cam, x.siteId)) };
    },
  );

  r.get(
    "/v1/cameras/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["cameras"],
        summary: "Get a camera",
        params: IdParams,
        response: { 200: CameraList.shape.items.element, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const rows = await withTenant(handle.db, t.orgId, async (tx) => {
        const scope = await visibleScope(tx, t);
        return tx
          .select({ cam: camera, siteId: device.siteId })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(and(eq(camera.id, req.params.id), cameraFilter(scope)))
          .limit(1);
      });
      const row = rows[0];
      if (!row) throw notFound("camera");
      return toCamera(row.cam, row.siteId);
    },
  );

  r.patch(
    "/v1/cameras/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["cameras"],
        summary: "Rename or reorder a camera (capabilities come from probing and cannot be edited)",
        params: IdParams,
        body: CameraPatch,
        response: { 200: CameraList.shape.items.element, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "operator");
      const changes = req.body;
      const row = await withTenant(handle.db, t.orgId, async (tx) => {
        const scope = await visibleScope(tx, t);
        const [found] = await tx
          .select({ cam: camera, siteId: device.siteId })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(and(eq(camera.id, req.params.id), cameraFilter(scope)))
          .limit(1);
        if (!found) return undefined;
        const decision = await cameraConfigAccess(tx, t, { id: found.cam.id, siteId: found.siteId });
        if (!decision.allowed) return "denied" as const;
        const [updated] = await tx.update(camera).set(changes).where(eq(camera.id, found.cam.id)).returning();
        await writeAudit(tx, t, "camera.update", found.cam.id, { fields: Object.keys(changes) });
        return { cam: updated as typeof camera.$inferSelect, siteId: found.siteId };
      });
      if (!row) throw notFound("camera");
      if (row === "denied")
        throw new AppError(403, "camera_not_granted", "You have no operate access to this camera");
      return toCamera(row.cam, row.siteId);
    },
  );
}

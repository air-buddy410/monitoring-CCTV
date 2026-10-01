import { AdapterError, onvifGenericAdapter } from "@pantau/adapters";
import {
  CameraList,
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
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { AppError, fromAdapterCode, notFound } from "../errors";
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

      const policy = checkTarget(body.host, { allowLoopback: config.allowLoopbackTargets });
      if (!policy.allowed) {
        return fail(
          new AppError(422, "target_not_allowed", "This address cannot be used as a device target"),
        );
      }

      const siteRow = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select({ id: site.id }).from(site).where(eq(site.id, body.siteId)).limit(1),
      );
      if (!siteRow[0]) throw notFound("site");

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
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx
          .select()
          .from(device)
          .where(siteId ? eq(device.siteId, siteId) : undefined)
          .orderBy(desc(device.createdAt)),
      );
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
        const [dev] = await tx.select().from(device).where(eq(device.id, req.params.id)).limit(1);
        if (!dev) return { dev: undefined, cams: [] };
        const cams = await tx
          .select()
          .from(camera)
          .where(eq(camera.deviceId, dev.id))
          .orderBy(asc(camera.sortOrder));
        return { dev, cams };
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
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx
          .select({ cam: camera, siteId: device.siteId })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(siteId ? eq(device.siteId, siteId) : undefined)
          .orderBy(asc(camera.deviceId), asc(camera.sortOrder)),
      );
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
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx
          .select({ cam: camera, siteId: device.siteId })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(and(eq(camera.id, req.params.id)))
          .limit(1),
      );
      const row = rows[0];
      if (!row) throw notFound("camera");
      return toCamera(row.cam, row.siteId);
    },
  );
}

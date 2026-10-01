import { IdParams, Site, SiteCreate, SiteList, SitePatch } from "@pantau/contracts";
import { camera, device, newId, site, withTenant } from "@pantau/db";
import { count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { notFound } from "../errors";
import { requireAny, requireRole } from "../tenant";
import { errorResponses, noContent } from "./shared";

export const toSite = (r: typeof site.$inferSelect): z.infer<typeof Site> => ({
  id: r.id,
  name: r.name,
  address: r.address,
  timezone: r.timezone,
  createdAt: r.createdAt.toISOString(),
});

export function siteRoutes(app: FastifyInstance, { handle, resolveTenant }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/v1/sites",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["sites"],
        summary: "Create a site",
        body: SiteCreate,
        response: { 201: Site, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireRole(req, "operator");
      const row = await withTenant(handle.db, t.orgId, async (tx) => {
        const [created] = await tx
          .insert(site)
          .values({ id: newId("site"), organizationId: t.orgId, ...req.body })
          .returning();
        const made = created as typeof site.$inferSelect;
        await writeAudit(tx, t, "site.create", made.id, {});
        return made;
      });
      return reply.status(201).send(toSite(row));
    },
  );
  r.get(
    "/v1/sites",
    {
      preHandler: resolveTenant,
      schema: { tags: ["sites"], summary: "List sites", response: { 200: SiteList, ...errorResponses } },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(site).orderBy(desc(site.createdAt)),
      );
      return { items: rows.map(toSite) };
    },
  );
  r.get(
    "/v1/sites/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["sites"],
        summary: "Get a site",
        params: IdParams,
        response: { 200: Site, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(site).where(eq(site.id, req.params.id)).limit(1),
      );
      if (!rows[0]) throw notFound("site");
      return toSite(rows[0]);
    },
  );
  r.patch(
    "/v1/sites/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["sites"],
        summary: "Edit a site (name, address, time zone)",
        params: IdParams,
        body: SitePatch,
        response: { 200: Site, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "operator");
      const changes = req.body;
      const row = await withTenant(handle.db, t.orgId, async (tx) => {
        const [updated] = await tx.update(site).set(changes).where(eq(site.id, req.params.id)).returning();
        if (updated) await writeAudit(tx, t, "site.update", updated.id, { fields: Object.keys(changes) });
        return updated;
      });
      if (!row) throw notFound("site");
      return toSite(row);
    },
  );
  r.delete(
    "/v1/sites/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["sites"],
        summary: "Delete a site with its devices, cameras and grants (owner or noc)",
        params: IdParams,
        response: { 204: noContent, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireAny(req, ["owner", "noc"]);
      const found = await withTenant(handle.db, t.orgId, async (tx) => {
        const [s] = await tx.select().from(site).where(eq(site.id, req.params.id)).limit(1);
        if (!s) return null;
        const [d] = await tx.select({ n: count() }).from(device).where(eq(device.siteId, s.id));
        const [c] = await tx
          .select({ n: count() })
          .from(camera)
          .innerJoin(device, eq(device.id, camera.deviceId))
          .where(eq(device.siteId, s.id));
        // audit first: the site row and its children go away in the same transaction
        await writeAudit(tx, t, "site.delete", s.id, {
          name: s.name,
          devices: d?.n ?? 0,
          cameras: c?.n ?? 0,
        });
        await tx.delete(site).where(eq(site.id, s.id));
        return s;
      });
      if (!found) throw notFound("site");
      return reply.status(204).send(null);
    },
  );
}

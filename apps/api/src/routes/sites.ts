import { IdParams, Site, SiteCreate, SiteList, SiteUpdate } from "@pantau/contracts";
import { newId, site, withTenant } from "@pantau/db";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { notFound } from "../errors";
import { requireRole } from "../tenant";
import { errorResponses } from "./shared";

const toSite = (r: typeof site.$inferSelect): z.infer<typeof Site> => ({
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
        return created as typeof site.$inferSelect;
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
  r.patch(
    "/v1/sites/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["sites"],
        summary: "Update a site",
        params: IdParams,
        body: SiteUpdate,
        response: { 200: Site, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "operator");
      const updated = await withTenant(handle.db, t.orgId, async (tx) => {
        const rows = await tx.update(site).set(req.body).where(eq(site.id, req.params.id)).returning();
        const row = rows[0];
        if (row) await writeAudit(tx, t, "site.update", row.id, { fields: Object.keys(req.body) });
        return row;
      });
      if (!updated) throw notFound("site");
      return toSite(updated as typeof site.$inferSelect);
    },
  );
  r.delete(
    "/v1/sites/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["sites"],
        summary: "Delete a site and everything under it (devices, cameras, secrets)",
        params: IdParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireRole(req, "owner");
      const removed = await withTenant(handle.db, t.orgId, async (tx) => {
        const rows = await tx.delete(site).where(eq(site.id, req.params.id)).returning({ id: site.id });
        if (rows[0]) await writeAudit(tx, t, "site.delete", rows[0].id);
        return rows[0];
      });
      if (!removed) throw notFound("site");
      return reply.status(204).send(null);
    },
  );
}

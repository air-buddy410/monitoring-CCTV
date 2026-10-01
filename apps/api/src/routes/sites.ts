import { Site, SiteCreate, SiteList } from "@pantau/contracts";
import { newId, site, withTenant } from "@pantau/db";
import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import type { Deps } from "../app";
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
}

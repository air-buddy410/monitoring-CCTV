import { Grant, GrantCreate, GrantList, GrantQuery, IdParams } from "@pantau/contracts";
import { camera, cameraGrant, device, member, newId, site, withTenant } from "@pantau/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { requireAny, requireRole } from "../tenant";
import { errorResponses, noContent } from "./shared";

const toGrant = (r: typeof cameraGrant.$inferSelect): z.infer<typeof Grant> => ({
  id: r.id,
  userId: r.userId,
  scope: r.scope as "site" | "camera",
  scopeId: r.scopeId,
  permission: r.permission as "view" | "operate",
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
});

export function grantRoutes(app: FastifyInstance, { handle, resolveTenant }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/grants",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["grants"],
        summary: "List grants. Owner and noc see the tenant; everyone else sees only their own.",
        querystring: GrantQuery,
        response: { 200: GrantList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "viewer");
      const manager = t.role === "owner" || t.role === "noc";
      const q = req.query;
      if (!manager && q.userId && q.userId !== t.userId) {
        throw new AppError(403, "forbidden", "Insufficient role");
      }
      const userId = manager ? q.userId : t.userId;
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx
          .select()
          .from(cameraGrant)
          .where(
            and(
              userId ? eq(cameraGrant.userId, userId) : undefined,
              q.scope ? eq(cameraGrant.scope, q.scope) : undefined,
              q.scopeId ? eq(cameraGrant.scopeId, q.scopeId) : undefined,
            ),
          )
          .orderBy(desc(cameraGrant.createdAt), desc(cameraGrant.id)),
      );
      return { items: rows.map(toGrant) };
    },
  );

  r.post(
    "/v1/grants",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["grants"],
        summary: "Grant a member view or operate access to a site or one camera (owner or noc)",
        body: GrantCreate,
        response: { 201: Grant, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireAny(req, ["owner", "noc"]);
      const b = req.body;
      const row = await withTenant(handle.db, t.orgId, async (tx) => {
        // `member` is not under RLS, so the organization is pinned explicitly
        const m = await tx
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, t.orgId), eq(member.userId, b.userId)))
          .limit(1);
        if (!m[0]) throw notFound("member");
        const target =
          b.scope === "site"
            ? await tx.select({ id: site.id }).from(site).where(eq(site.id, b.scopeId)).limit(1)
            : await tx
                .select({ id: camera.id })
                .from(camera)
                .innerJoin(device, eq(device.id, camera.deviceId))
                .where(eq(camera.id, b.scopeId))
                .limit(1);
        if (!target[0]) throw notFound(b.scope);
        const dup = await tx
          .select({ id: cameraGrant.id })
          .from(cameraGrant)
          .where(
            and(
              eq(cameraGrant.userId, b.userId),
              eq(cameraGrant.scope, b.scope),
              eq(cameraGrant.scopeId, b.scopeId),
            ),
          )
          .limit(1);
        if (dup[0]) throw new AppError(409, "grant_exists", "This member already has a grant on that target");
        const [created] = await tx
          .insert(cameraGrant)
          .values({ id: newId("grt"), organizationId: t.orgId, createdBy: t.userId, ...b })
          .returning();
        const made = created as typeof cameraGrant.$inferSelect;
        await writeAudit(tx, t, "grant.create", made.id, {
          userId: b.userId,
          scope: b.scope,
          scopeId: b.scopeId,
          permission: b.permission,
        });
        return made;
      });
      return reply.status(201).send(toGrant(row));
    },
  );

  r.delete(
    "/v1/grants/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["grants"],
        summary: "Revoke a grant (owner or noc)",
        params: IdParams,
        response: { 204: noContent, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireAny(req, ["owner", "noc"]);
      const removed = await withTenant(handle.db, t.orgId, async (tx) => {
        const [g] = await tx.delete(cameraGrant).where(eq(cameraGrant.id, req.params.id)).returning();
        if (g) {
          await writeAudit(tx, t, "grant.delete", g.id, {
            userId: g.userId,
            scope: g.scope,
            scopeId: g.scopeId,
            permission: g.permission,
          });
        }
        return g;
      });
      if (!removed) throw notFound("grant");
      return reply.status(204).send(null);
    },
  );
}

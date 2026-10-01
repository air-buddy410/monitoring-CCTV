import { Grant, GrantCreate, GrantList, IdParams } from "@pantau/contracts";
import { camera, cameraGrant, member, newId, site, withTenant } from "@pantau/db";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../app";
import { writeAudit } from "../audit";
import { AppError, notFound } from "../errors";
import { requireRole } from "../tenant";
import { errorResponses } from "./shared";

const toGrant = (r: typeof cameraGrant.$inferSelect): z.infer<typeof Grant> => ({
  id: r.id,
  userId: r.userId,
  scope: r.scope as "site" | "camera",
  scopeId: r.scopeId,
  permission: r.permission as "view" | "operate",
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
        summary: "List camera/site grants of the current tenant (owner only)",
        response: { 200: GrantList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "owner");
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(cameraGrant).orderBy(desc(cameraGrant.createdAt)),
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
        summary: "Grant a member access to a site or a camera (owner only)",
        description:
          "The target user must already be a member of this tenant and the scope id must belong to this tenant. Grants only narrow a role; they never widen it.",
        body: GrantCreate,
        response: { 201: Grant, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireRole(req, "owner");
      const body = req.body;
      const created = await withTenant(handle.db, t.orgId, async (tx) => {
        const isMember = await tx
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, t.orgId), eq(member.userId, body.userId)))
          .limit(1);
        if (!isMember[0])
          throw new AppError(422, "grant_user_not_member", "User is not a member of this tenant");

        if (body.scope === "site") {
          const s = await tx.select({ id: site.id }).from(site).where(eq(site.id, body.scopeId)).limit(1);
          if (!s[0]) throw new AppError(422, "grant_scope_not_found", "Site does not exist in this tenant");
        } else {
          const c = await tx
            .select({ id: camera.id })
            .from(camera)
            .where(eq(camera.id, body.scopeId))
            .limit(1);
          if (!c[0]) throw new AppError(422, "grant_scope_not_found", "Camera does not exist in this tenant");
        }

        const dup = await tx
          .select({ id: cameraGrant.id })
          .from(cameraGrant)
          .where(
            and(
              eq(cameraGrant.userId, body.userId),
              eq(cameraGrant.scope, body.scope),
              eq(cameraGrant.scopeId, body.scopeId),
            ),
          )
          .limit(1);
        if (dup[0]) throw new AppError(409, "grant_exists", "This grant already exists");

        const [inserted] = await tx
          .insert(cameraGrant)
          .values({
            id: newId("grt"),
            organizationId: t.orgId,
            userId: body.userId,
            scope: body.scope,
            scopeId: body.scopeId,
            permission: body.permission,
          })
          .returning();
        const row = inserted as typeof cameraGrant.$inferSelect;
        await writeAudit(tx, t, "grant.create", row.id, {
          userId: body.userId,
          scope: body.scope,
          scopeId: body.scopeId,
          permission: body.permission,
        });
        return row;
      });
      return reply.status(201).send(toGrant(created));
    },
  );

  r.delete(
    "/v1/grants/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["grants"],
        summary: "Revoke a grant (owner only)",
        params: IdParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireRole(req, "owner");
      const removed = await withTenant(handle.db, t.orgId, async (tx) => {
        const rows = await tx
          .delete(cameraGrant)
          .where(eq(cameraGrant.id, req.params.id))
          .returning({ id: cameraGrant.id });
        if (rows[0]) await writeAudit(tx, t, "grant.delete", rows[0].id);
        return rows[0];
      });
      if (!removed) throw notFound("grant");
      return reply.status(204).send(null);
    },
  );
}

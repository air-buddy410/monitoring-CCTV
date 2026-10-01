import { AuditList, AuditQuery } from "@pantau/contracts";
import { auditLog, withTenant } from "@pantau/db";
import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../app";
import { requireRole } from "../tenant";
import { errorResponses } from "./shared";

export function auditRoutes(app: FastifyInstance, { handle, resolveTenant }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/v1/audit",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["audit"],
        summary: "Audit log of the current tenant (owner only)",
        querystring: AuditQuery,
        response: { 200: AuditList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireRole(req, "owner");
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(auditLog).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(req.query.limit),
      );
      return {
        items: rows.map((a) => ({
          id: a.id,
          actorId: a.actorId,
          action: a.action,
          target: a.target,
          ip: a.ip,
          at: a.at.toISOString(),
          meta: a.meta as Record<string, unknown>,
        })),
      };
    },
  );
}

import { AuditList, AuditQuery } from "@pantau/contracts";
import { auditLog, withTenant } from "@pantau/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../app";
import { requireAny } from "../tenant";
import { errorResponses } from "./shared";

export function auditRoutes(app: FastifyInstance, { handle, resolveTenant }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/v1/audit",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["audit"],
        summary: "Audit log of the current tenant (owner or noc), filterable by action and time",
        querystring: AuditQuery,
        response: { 200: AuditList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc"]);
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(
              req.query.action ? eq(auditLog.action, req.query.action) : undefined,
              req.query.from ? gte(auditLog.at, new Date(req.query.from)) : undefined,
              req.query.to ? lte(auditLog.at, new Date(req.query.to)) : undefined,
            ),
          )
          .orderBy(desc(auditLog.at), desc(auditLog.id))
          .limit(req.query.limit),
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

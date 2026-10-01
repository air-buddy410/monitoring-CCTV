import { randomBytes } from "node:crypto";
import {
  AgentEnroll,
  AgentEnrollmentCreate,
  AgentEnrollmentCreated,
  AgentEnrollResult,
  AgentList,
  IdParams,
} from "@pantau/contracts";
import { agent, agentEnrollment, newId, site, withTenant } from "@pantau/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  hashAgentToken,
  newAgentToken,
  newEnrollmentToken,
  parseEnrollmentToken,
  sha256,
} from "../agent-token";
import type { Deps } from "../app";
import { writeAudit, writeAuditSystem } from "../audit";
import { AppError, notFound } from "../errors";
import { toAgent } from "../mappers";
import { requireAny } from "../tenant";
import { errorResponses, noContent } from "./shared";

const ENROLLMENT_TTL_MAX_MIN = 1440;

export function agentRoutes(app: FastifyInstance, { handle, resolveTenant }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- enrollment: created by owner/noc for one site; single use; token shown once ----
  r.post(
    "/v1/sites/:id/enrollments",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Create a single-use agent enrollment token for a site (owner or noc)",
        params: IdParams,
        body: AgentEnrollmentCreate,
        response: { 201: AgentEnrollmentCreated, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireAny(req, ["owner", "noc"]);
      const ttlMinutes = Math.min(req.body.ttlMinutes, ENROLLMENT_TTL_MAX_MIN);
      const enrollmentId = newId("enr");
      const token = newEnrollmentToken(t.orgId, enrollmentId);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
      const created = await withTenant(handle.db, t.orgId, async (tx) => {
        const [s] = await tx.select({ id: site.id }).from(site).where(eq(site.id, req.params.id)).limit(1);
        if (!s) return null;
        const [row] = await tx
          .insert(agentEnrollment)
          .values({
            id: enrollmentId,
            organizationId: t.orgId,
            siteId: s.id,
            tokenHash: sha256(token),
            expiresAt,
          })
          .returning();
        await writeAudit(tx, t, "agent.enrollment.create", enrollmentId, {
          siteId: s.id,
          name: req.body.name,
        });
        return row as typeof agentEnrollment.$inferSelect;
      });
      if (!created) throw notFound("site");
      return reply.status(201).send({
        id: created.id,
        siteId: created.siteId,
        token,
        expiresAt: created.expiresAt.toISOString(),
      });
    },
  );

  // ---- enroll: the agent presents its single-use token and receives a long-lived agent token ----
  r.post(
    "/v1/agents/enroll",
    {
      schema: {
        tags: ["agents"],
        summary: "Exchange a single-use enrollment token for a long-lived agent token",
        description:
          "Unauthenticated by session: the enrollment token itself authorizes this call. The token is single-use and time-limited; only its hash is stored.",
        body: AgentEnroll,
        response: { 201: AgentEnrollResult, ...errorResponses },
      },
    },
    async (req, reply) => {
      const parsed = parseEnrollmentToken(req.body.token);
      if (!parsed) throw new AppError(401, "invalid_enrollment_token", "Invalid enrollment token");
      const agentId = newId("agt");
      const agentToken = newAgentToken(parsed.orgId, agentId);
      const result = await withTenant(handle.db, parsed.orgId, async (tx) => {
        const [enr] = await tx
          .select()
          .from(agentEnrollment)
          .where(and(eq(agentEnrollment.id, parsed.enrollmentId), isNull(agentEnrollment.usedAt)))
          .limit(1);
        if (!enr || enr.tokenHash !== sha256(req.body.token)) {
          await writeAuditSystem(tx, parsed.orgId, req.ip, "agent.enroll.failed", parsed.enrollmentId, {
            reason: "unknown_or_used",
          });
          return null;
        }
        if (enr.expiresAt.getTime() < Date.now()) {
          await writeAuditSystem(tx, parsed.orgId, req.ip, "agent.enroll.failed", enr.id, {
            reason: "expired",
          });
          return null;
        }
        await tx.update(agentEnrollment).set({ usedAt: new Date() }).where(eq(agentEnrollment.id, enr.id));
        const [row] = await tx
          .insert(agent)
          .values({
            id: agentId,
            organizationId: parsed.orgId,
            siteId: enr.siteId,
            name: req.body.name,
            version: req.body.version,
            publicKey: req.body.publicKey ?? null,
            tokenHash: hashAgentToken({
              orgId: parsed.orgId,
              agentId,
              secret: agentToken.split(".")[3] ?? "",
            }),
            lastSeenAt: new Date(),
            status: "online",
          })
          .returning();
        await writeAuditSystem(tx, parsed.orgId, req.ip, "agent.enroll", row?.id ?? agentId, {
          siteId: enr.siteId,
          version: req.body.version,
        });
        return row ? { agentId: row.id, agentToken } : null;
      });
      if (!result) throw new AppError(401, "invalid_enrollment_token", "Invalid or expired enrollment token");
      return reply.status(201).send(result);
    },
  );

  // ---- registry ----
  r.get(
    "/v1/agents",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "List agents of the current tenant",
        response: { 200: AgentList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc"]);
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(agent).orderBy(desc(agent.createdAt)),
      );
      return { items: rows.map(toAgent) };
    },
  );

  r.get(
    "/v1/agents/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Get an agent",
        params: IdParams,
        response: { 200: AgentList.shape.items.element, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc"]);
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(agent).where(eq(agent.id, req.params.id)).limit(1),
      );
      if (!rows[0]) throw notFound("agent");
      return toAgent(rows[0]);
    },
  );

  r.post(
    "/v1/agents/:id/revoke",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Revoke an agent (owner or noc); it can no longer authenticate",
        params: IdParams,
        response: { 200: AgentList.shape.items.element, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc"]);
      // Revocation overwrites the stored hash with an unguessable value, so the old token can never match
      // again even if this row is later restored from a backup.
      const revokedTokenHash = hashAgentToken({
        orgId: t.orgId,
        agentId: req.params.id,
        secret: randomBytes(32).toString("base64url"),
      });
      const row = await withTenant(handle.db, t.orgId, async (tx) => {
        const [updated] = await tx
          .update(agent)
          .set({ status: "revoked", tokenHash: revokedTokenHash })
          .where(eq(agent.id, req.params.id))
          .returning();
        if (updated) await writeAudit(tx, t, "agent.revoke", updated.id, {});
        return updated;
      });
      if (!row) throw notFound("agent");
      return toAgent(row);
    },
  );

  r.delete(
    "/v1/agents/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Delete a revoked agent (owner only)",
        params: IdParams,
        response: { 204: noContent, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireAny(req, ["owner"]);
      const found = await withTenant(handle.db, t.orgId, async (tx) => {
        const [row] = await tx.select().from(agent).where(eq(agent.id, req.params.id)).limit(1);
        if (!row) return null;
        if (row.status !== "revoked") {
          throw new AppError(409, "agent_not_revoked", "Revoke the agent before deleting it");
        }
        await tx.delete(agent).where(eq(agent.id, row.id));
        return row;
      });
      if (!found) throw notFound("agent");
      return reply.status(204).send(null);
    },
  );
}

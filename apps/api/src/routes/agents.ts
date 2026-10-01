import { createHash, createPublicKey } from "node:crypto";
import {
  Agent,
  AgentEnrollRequest,
  AgentEnrollResponse,
  AgentList,
  ENROLLMENT_TTL_HOURS,
  EnrollmentCreate,
  EnrollmentResponse,
  IdParams,
} from "@pantau/contracts";
import { agent, agentEnrollment, enterTenant, newId, site, withTenant, withTokenHash } from "@pantau/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { z } from "zod";
import type { Deps } from "../app";
import { writeAudit, writeAuditSystem } from "../audit";
import { AppError, notFound, rateLimited } from "../errors";
import { requireAny } from "../tenant";
import { bearerOf, hashToken, newToken } from "../tokens";
import { errorResponses } from "./shared";

type AgentRow = typeof agent.$inferSelect;

export const fingerprint = (publicKey: string) =>
  createHash("sha256").update(publicKey).digest("hex").slice(0, 16);

export function toAgent(r: AgentRow, online: boolean): z.infer<typeof Agent> {
  const ls = r.lastStatus as z.infer<typeof Agent>["lastStatus"];
  return {
    id: r.id,
    siteId: r.siteId,
    name: r.name,
    version: r.version,
    go2rtcVersion: r.go2rtcVersion,
    hostname: r.hostname,
    status: r.revokedAt ? "revoked" : online ? "online" : "offline",
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
    publicKeyFingerprint: fingerprint(r.publicKey),
    lastStatus: ls ?? null,
  };
}

const enrollmentInvalid = () =>
  new AppError(401, "enrollment_invalid", "Enrollment token is invalid, used or expired");

function assertEd25519(publicKeyB64: string): void {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType === "ed25519") return;
  } catch {
    // falls through to the refusal below
  }
  throw new AppError(400, "invalid_public_key", "publicKey must be an Ed25519 public key (SPKI DER, base64)");
}

export function agentRoutes(app: FastifyInstance, deps: Deps) {
  const { handle, resolveTenant, hub, config, limiter } = deps;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/sites/:id/enrollments",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Mint a single-use agent enrollment token for a site (owner or noc)",
        description: `The token is valid ${ENROLLMENT_TTL_HOURS} hours, is returned once and only its SHA-256 is stored.`,
        params: IdParams,
        body: EnrollmentCreate,
        response: { 201: EnrollmentResponse, ...errorResponses },
      },
    },
    async (req, reply) => {
      const t = requireAny(req, ["owner", "noc"]);
      const token = newToken("enrollment");
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_HOURS * 3_600_000);
      const id = newId("enr");
      await withTenant(handle.db, t.orgId, async (tx) => {
        const found = await tx.select({ id: site.id }).from(site).where(eq(site.id, req.params.id)).limit(1);
        if (!found[0]) throw notFound("site");
        await tx.insert(agentEnrollment).values({
          id,
          organizationId: t.orgId,
          siteId: req.params.id,
          tokenHash: hashToken(token),
          createdBy: t.userId,
          expiresAt,
        });
        await writeAudit(tx, t, "agent.enrollment.create", id, {
          siteId: req.params.id,
          expiresAt: expiresAt.toISOString(),
        });
      });
      return reply.status(201).send({ id, siteId: req.params.id, token, expiresAt: expiresAt.toISOString() });
    },
  );

  r.post(
    "/v1/agent/enroll",
    {
      schema: {
        tags: ["agents"],
        summary: "Register an agent with an enrollment token (header `Authorization: Enroll <token>`)",
        description:
          "Public endpoint: the single-use token is the credential. Returns the long-lived agent token once.",
        security: [],
        body: AgentEnrollRequest,
        response: { 201: AgentEnrollResponse, ...errorResponses },
      },
    },
    async (req, reply) => {
      const gate = limiter.hit(`agent-enroll:${req.ip}`, config.rateLimit.auth);
      if (!gate.allowed) throw rateLimited(gate.retryAfterSec);
      const token = bearerOf(req.headers.authorization, "Enroll", "enrollment");
      if (!token) throw enrollmentInvalid();
      assertEd25519(req.body.publicKey);
      const body = req.body;
      const agentToken = newToken("agent");
      const agentId = newId("agt");

      const result = await withTokenHash(handle.db, hashToken(token), async (tx) => {
        const [enr] = await tx
          .select()
          .from(agentEnrollment)
          .where(and(isNull(agentEnrollment.usedAt), gt(agentEnrollment.expiresAt, new Date())))
          .limit(1);
        if (!enr) throw enrollmentInvalid();
        await enterTenant(tx, enr.organizationId);
        // the conditional update is the claim: of any number of concurrent redemptions only one gets a row back
        const claimed = await tx
          .update(agentEnrollment)
          .set({ usedAt: new Date(), usedByAgentId: agentId })
          .where(
            and(
              eq(agentEnrollment.id, enr.id),
              isNull(agentEnrollment.usedAt),
              gt(agentEnrollment.expiresAt, new Date()),
            ),
          )
          .returning({ id: agentEnrollment.id });
        if (!claimed[0]) throw enrollmentInvalid();
        await tx.insert(agent).values({
          id: agentId,
          organizationId: enr.organizationId,
          siteId: enr.siteId,
          name: body.name,
          version: body.agentVersion ?? "",
          hostname: body.hostname ?? "",
          publicKey: body.publicKey,
          tokenHash: hashToken(agentToken),
        });
        await writeAuditSystem(tx, enr.organizationId, req.ip, "agent.enroll", agentId, {
          siteId: enr.siteId,
          enrollmentId: enr.id,
        });
        return { siteId: enr.siteId };
      });
      return reply
        .status(201)
        .send({ agentId, siteId: result.siteId, agentToken, websocketPath: "/agent" as const });
    },
  );

  r.get(
    "/v1/agents",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "List agents (owner, noc, operator)",
        response: { 200: AgentList, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc", "operator"]);
      const rows = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(agent).orderBy(desc(agent.createdAt)),
      );
      return { items: rows.map((a) => toAgent(a, hub.isOnline(a.id))) };
    },
  );

  r.get(
    "/v1/agents/:id",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Get an agent (owner, noc, operator)",
        params: IdParams,
        response: { 200: Agent, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc", "operator"]);
      const [row] = await withTenant(handle.db, t.orgId, (tx) =>
        tx.select().from(agent).where(eq(agent.id, req.params.id)).limit(1),
      );
      if (!row) throw notFound("agent");
      return toAgent(row, hub.isOnline(row.id));
    },
  );

  r.post(
    "/v1/agents/:id/revoke",
    {
      preHandler: resolveTenant,
      schema: {
        tags: ["agents"],
        summary: "Revoke an agent's token and close its connection (owner or noc). Idempotent.",
        params: IdParams,
        response: { 200: Agent, ...errorResponses },
      },
    },
    async (req) => {
      const t = requireAny(req, ["owner", "noc"]);
      const row = await withTenant(handle.db, t.orgId, async (tx) => {
        const [current] = await tx.select().from(agent).where(eq(agent.id, req.params.id)).limit(1);
        if (!current) return undefined;
        if (current.revokedAt) return current;
        const [updated] = await tx
          .update(agent)
          .set({ revokedAt: new Date(), status: "revoked" })
          .where(eq(agent.id, current.id))
          .returning();
        await writeAudit(tx, t, "agent.revoke", current.id, { siteId: current.siteId });
        return updated;
      });
      if (!row) throw notFound("agent");
      hub.disconnect(row.id, 4401, "revoked");
      return toAgent(row, false);
    },
  );
}

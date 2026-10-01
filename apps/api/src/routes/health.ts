import { NotReadyResponse, ReadyResponse } from "@pantau/contracts";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../app";

export function healthRoutes(app: FastifyInstance, { handle, readiness }: Deps) {
  readiness.register("db", async () => {
    await handle.db.execute(sql`select 1`);
  });
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness",
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );
  r.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary:
          "Readiness: every registered check (PostgreSQL, later pg-boss) must pass within the deadline",
        response: { 200: ReadyResponse, 503: NotReadyResponse },
      },
    },
    async (_req, reply) => {
      const result = await readiness.run();
      if (result.ok) return { status: "ready" as const, checks: result.checks };
      return reply.status(503).send({ status: "unavailable" as const, failed: result.failed });
    },
  );
}

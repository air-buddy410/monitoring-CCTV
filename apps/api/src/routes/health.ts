import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Deps } from "../app";

export function healthRoutes(app: FastifyInstance, { handle }: Deps) {
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
        summary: "Readiness (checks PostgreSQL)",
        response: {
          200: z.object({ status: z.literal("ready") }),
          503: z.object({ status: z.literal("unavailable") }),
        },
      },
    },
    async (_req, reply) => {
      try {
        await handle.db.execute(sql`select 1`);
        return { status: "ready" as const };
      } catch {
        return reply.status(503).send({ status: "unavailable" as const });
      }
    },
  );
}

import swagger from "@fastify/swagger";
import { createAuth } from "@pantau/auth";
import { createDb, type DbHandle } from "@pantau/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { AgentHub } from "./agent-hub";
import type { Config } from "./config";
import { AppError, rateLimited } from "./errors";
import { createLogger } from "./logger";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { createReadiness, type Readiness } from "./readiness";
import { agentWsRoutes } from "./routes/agent-ws";
import { agentRoutes } from "./routes/agents";
import { auditRoutes } from "./routes/audit";
import { deviceRoutes } from "./routes/devices";
import { grantRoutes } from "./routes/grants";
import { healthRoutes } from "./routes/health";
import { siteRoutes } from "./routes/sites";
import { snapshotRoutes } from "./routes/snapshot";
import { createTenantResolver, headersFromNode, type Role } from "./tenant";
import { createVault, type Vault } from "./vault";

export interface Deps {
  config: Config;
  handle: DbHandle;
  vault: Vault;
  resolveTenant: ReturnType<typeof createTenantResolver>;
  limiter: RateLimiter;
  readiness: Readiness;
  hub: AgentHub;
}
export interface BuiltApp {
  app: FastifyInstance;
  auth: ReturnType<typeof createAuth>;
  handle: DbHandle;
  readiness: Readiness;
  hub: AgentHub;
  close(): Promise<void>;
}
export type { Role };

const PROBLEM = "application/problem+json";
// endpoints that verify or set a password: throttled per client address and per account
const CREDENTIAL_PATHS =
  /^\/api\/auth\/(sign-in|sign-up|forget-password|reset-password|change-password|two-factor\/(verify-totp|verify-backup-code|verify-otp|enable|disable))(\/|$)/;

export async function buildApp(opts: {
  config: Config;
  logStream?: NodeJS.WritableStream;
}): Promise<BuiltApp> {
  const { config } = opts;
  const handle = createDb(config.databaseUrl);
  const auth = createAuth({
    db: handle.db,
    secret: config.authSecret,
    baseURL: config.baseUrl,
    trustedOrigins: config.trustedOrigins,
  });
  const limiter = createRateLimiter({ windowMs: config.rateLimit.windowMs });
  const trusted = new Set(config.trustedOrigins);
  const vault = createVault(config.vaultKey);

  const app = Fastify({
    loggerInstance: createLogger(config.logLevel, opts.logStream),
    genReqId: () => crypto.randomUUID(),
    trustProxy: config.trustProxy,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "PANTAU API (MVP-0)",
        version: "0.0.1",
        description:
          "Vertical slice: add device -> ONVIF probe -> cameras -> JPEG snapshot. Authentication and organizations (tenants) are provided by Better Auth under `/api/auth/*` (e.g. `POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `POST /api/auth/organization/create`, `POST /api/auth/organization/set-active`); a session cookie is required on every `/v1` endpoint. Errors use `application/problem+json`.",
      },
      tags: [
        { name: "health" },
        { name: "sites" },
        { name: "devices" },
        { name: "grants" },
        { name: "agents" },
        { name: "cameras" },
        { name: "audit" },
      ],
      components: {
        securitySchemes: {
          cookieAuth: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
        },
      },
      security: [{ cookieAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  // CSRF: state-changing requests must come from a trusted origin. Browsers always send Origin on
  // cross-origin writes, so a present-but-untrusted Origin (or Sec-Fetch-Site: cross-site) is rejected.
  // Requests with neither header are non-browser clients and cannot be forged through a victim's browser.
  app.addHook("onRequest", async (req) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite === "cross-site" || (origin !== undefined && !trusted.has(origin))) {
      throw new AppError(403, "csrf_origin_rejected", "Request origin is not trusted");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    let problem: AppError;
    if (err instanceof AppError) problem = err;
    else if (hasZodFastifySchemaValidationErrors(err)) {
      // paths and messages only; never echo submitted values (they may contain credentials)
      const detail = err.validation.map((v) => `${v.instancePath || "/"}: ${v.message}`).join("; ");
      problem = new AppError(400, "validation_error", "Invalid request", detail);
    } else if ((err as { statusCode?: number }).statusCode === 400) {
      problem = new AppError(400, "bad_request", "Bad request");
    } else {
      req.log.error({ errName: (err as Error).name }, "unhandled error");
      problem = new AppError(500, "internal_error", "Internal server error");
    }
    if (problem.retryAfterSec) reply.header("retry-after", String(problem.retryAfterSec));
    reply
      .status(problem.status)
      .header("content-type", PROBLEM)
      .send({
        type: `about:blank#${problem.code}`,
        title: problem.title,
        status: problem.status,
        code: problem.code,
        ...(problem.detail ? { detail: problem.detail } : {}),
        requestId: req.id,
      });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).header("content-type", PROBLEM).send({
      type: "about:blank#not_found",
      title: "Not Found",
      status: 404,
      code: "not_found",
      requestId: req.id,
    });
  });

  // Better Auth (login, sessions, organizations)
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    handler: async (req, reply) => {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "POST" && CREDENTIAL_PATHS.test(url.pathname)) {
        const email = (req.body as { email?: unknown } | null)?.email;
        const keys = [`auth:ip:${req.ip}`];
        if (typeof email === "string") keys.push(`auth:email:${email.trim().toLowerCase().slice(0, 254)}`);
        const results = keys.map((k) => limiter.hit(k, config.rateLimit.auth));
        const blocked = results.find((r) => !r.allowed);
        if (blocked) throw rateLimited(blocked.retryAfterSec);
      }
      const headers = headersFromNode(req.headers);
      headers.delete("content-length");
      const hasBody = req.method !== "GET" && req.body !== undefined && req.body !== null;
      const response = await auth.handler(
        new Request(url, {
          method: req.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  const readiness = createReadiness(config.readinessTimeoutMs);
  const deps: Deps = {
    config,
    handle,
    vault,
    limiter,
    readiness,
    hub: new AgentHub(),
    resolveTenant: createTenantResolver(auth, handle.db),
  };
  app.get("/docs/json", { schema: { hide: true } }, async () => app.swagger());
  healthRoutes(app, deps);
  siteRoutes(app, deps);
  deviceRoutes(app, deps);
  snapshotRoutes(app, deps);
  grantRoutes(app, deps);
  agentRoutes(app, deps);
  await agentWsRoutes(app, deps);
  auditRoutes(app, deps);

  app.withTypeProvider<ZodTypeProvider>();
  return {
    app,
    auth,
    handle,
    readiness,
    hub: deps.hub,
    async close() {
      deps.hub.closeAll();
      await app.close();
      await handle.close();
    },
  };
}

import { account, type Db, invitation, member, organization, session, user, verification } from "@pantau/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization as organizationPlugin } from "better-auth/plugins";

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
}

/**
 * Better Auth with the organization plugin. An organization is a tenant (PRD section 3).
 * Roles: owner / admin / member (mapped to owner / operator / viewer in the API).
 * 2FA is out of MVP-0 scope.
 */
export function createAuth(opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins ?? [opts.baseURL],
    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: { user, session, account, verification, organization, member, invitation },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, autoSignIn: true },
    plugins: [organizationPlugin()],
    logger: { level: "error" },
  });
}
export type Auth = ReturnType<typeof createAuth>;

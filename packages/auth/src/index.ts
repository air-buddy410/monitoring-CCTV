import {
  account,
  type Db,
  invitation,
  member,
  organization,
  session,
  twoFactor,
  user,
  verification,
} from "@pantau/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization as organizationPlugin, twoFactor as twoFactorPlugin } from "better-auth/plugins";

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
}

/**
 * Better Auth with the organization plugin (tenant, PRD section 3) and two-factor
 * (TOTP + backup codes, PRD F7 / section 11). Roles: owner / admin / member
 * (mapped to owner / operator / viewer in the API).
 */
export function createAuth(opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins ?? [opts.baseURL],
    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: { user, session, account, verification, organization, member, invitation, twoFactor },
    }),
    // Explicit: Better Auth otherwise disables the Origin/CSRF check whenever NODE_ENV === "test".
    advanced: { disableOriginCheck: false },
    emailAndPassword: { enabled: true, minPasswordLength: 12, autoSignIn: true },
    plugins: [organizationPlugin(), twoFactorPlugin({ issuer: "PANTAU" })],
    logger: { level: "error" },
  });
}
export type Auth = ReturnType<typeof createAuth>;

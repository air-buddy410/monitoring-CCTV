import {
  account,
  type Db,
  invitation,
  member,
  organization,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
} from "@pantau/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization as organizationPlugin, twoFactor } from "better-auth/plugins";

export interface AuthOptions {
  db: Db;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
}

/**
 * Better Auth with the organization plugin. An organization is a tenant (PRD section 3).
 * Roles: owner / admin / member (mapped to owner / operator / viewer in the API).
 * Two-factor (TOTP + backup codes) is enabled per user; the second step is required at sign-in once confirmed.
 */
export function createAuth(opts: AuthOptions) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins ?? [opts.baseURL],
    database: drizzleAdapter(opts.db, {
      provider: "pg",
      schema: {
        user,
        session,
        account,
        verification,
        organization,
        member,
        invitation,
        twoFactor: twoFactorTable,
      },
    }),
    // Explicit: Better Auth otherwise disables the Origin/CSRF check whenever NODE_ENV === "test".
    advanced: { disableOriginCheck: false },
    emailAndPassword: { enabled: true, minPasswordLength: 12, autoSignIn: true },
    plugins: [
      organizationPlugin(),
      // TOTP with backup codes. Enabling does not take effect until a code is confirmed (no skipVerificationOnEnable).
      twoFactor({ issuer: "PANTAU" }),
    ],
    logger: { level: "error" },
  });
}
export type Auth = ReturnType<typeof createAuth>;

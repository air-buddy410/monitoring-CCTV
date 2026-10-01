import type { Auth } from "@pantau/auth";
import { type Db, member } from "@pantau/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { AppError } from "./errors";

export type Role = "owner" | "noc" | "operator" | "viewer";
// Linear rank is for inventory and configuration. `noc` ranks with operator there but is never a video role
// (PRD section 2), so video endpoints use requireAny with an explicit list instead.
const RANK: Record<Role, number> = { viewer: 1, operator: 2, noc: 2, owner: 3 };
// Better Auth org roles -> PRD roles (PRD section 2). `noc` is a member role string set by an administrator.
const ROLE_MAP: Record<string, Role> = { owner: "owner", admin: "operator", member: "viewer", noc: "noc" };

export interface TenantContext {
  userId: string;
  orgId: string;
  role: Role;
  ip: string;
  /** Whether the signed-in user has confirmed two-factor authentication. */
  twoFactor: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    tenant?: TenantContext;
  }
}

export function headersFromNode(h: FastifyRequest["headers"]): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else out.set(k, v);
  }
  return out;
}

/**
 * Resolve the tenant from the server-side session only. The organization is never read from the
 * request body/query. Membership is re-verified on every request.
 */
export function createTenantResolver(auth: Auth, db: Db) {
  return async (req: FastifyRequest): Promise<void> => {
    const session = await auth.api.getSession({ headers: headersFromNode(req.headers) });
    if (!session) throw new AppError(401, "unauthenticated", "Authentication required");
    const orgId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    if (!orgId) throw new AppError(403, "no_active_organization", "Select an organization first");
    const rows = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, session.user.id)))
      .limit(1);
    const role = rows[0] ? ROLE_MAP[rows[0].role] : undefined;
    if (!role) throw new AppError(403, "not_a_member", "You are not a member of this organization");
    const twoFactor = (session.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true;
    req.tenant = { userId: session.user.id, orgId, role, ip: req.ip, twoFactor };
  };
}

export function requireRole(req: FastifyRequest, min: Role): TenantContext {
  const t = req.tenant;
  if (!t) throw new AppError(401, "unauthenticated", "Authentication required");
  if (RANK[t.role] < RANK[min]) throw new AppError(403, "forbidden", "Insufficient role");
  return t;
}

/** Exact role list, for actions where the linear rank is wrong (video excludes noc; grants are owner or noc). */
export function requireAny(req: FastifyRequest, roles: readonly Role[]): TenantContext {
  const t = req.tenant;
  if (!t) throw new AppError(401, "unauthenticated", "Authentication required");
  if (!roles.includes(t.role)) throw new AppError(403, "forbidden", "Insufficient role");
  return t;
}

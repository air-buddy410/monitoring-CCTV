import { cameraGrant, type Tx } from "@pantau/db";
import { and, eq, or } from "drizzle-orm";
import type { TenantContext } from "./tenant";

export type Permission = "view" | "operate";
export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "no_grant" | "view_only" | "role" };

/**
 * Video access for one camera (PRD sections 2 and 8). The role sets the ceiling, a grant narrows it:
 * the owner reaches every camera of the tenant, operator and viewer reach only granted sites or cameras,
 * and `noc` never reaches video. `need` is the permission the action requires.
 */
export async function cameraAccess(
  tx: Tx,
  t: Pick<TenantContext, "orgId" | "userId" | "role">,
  cam: { id: string; siteId: string },
  need: Permission,
): Promise<AccessDecision> {
  if (t.role === "noc") return { allowed: false, reason: "role" };
  if (t.role === "viewer" && need === "operate") return { allowed: false, reason: "role" };
  if (t.role === "owner") return { allowed: true };
  const rows = await tx
    .select({ permission: cameraGrant.permission })
    .from(cameraGrant)
    .where(
      and(
        eq(cameraGrant.userId, t.userId),
        or(
          and(eq(cameraGrant.scope, "camera"), eq(cameraGrant.scopeId, cam.id)),
          and(eq(cameraGrant.scope, "site"), eq(cameraGrant.scopeId, cam.siteId)),
        ),
      ),
    );
  if (rows.length === 0) return { allowed: false, reason: "no_grant" };
  if (need === "view") return { allowed: true };
  return rows.some((r) => r.permission === "operate")
    ? { allowed: true }
    : { allowed: false, reason: "view_only" };
}

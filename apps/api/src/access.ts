import { camera, cameraGrant, device, site, type Tx } from "@pantau/db";
import { and, eq, inArray, or } from "drizzle-orm";
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

/**
 * What an operator or viewer may see of the tenant's inventory, derived from their grants (PRD sections 2 and 8).
 * `null` means unrestricted: the owner, and noc (inventory and health, never video). Everyone else is default-deny.
 */
export interface VisibleScope {
  /** Sites granted as a whole. */
  siteIds: string[];
  cameraIds: string[];
  /** Sites that hold at least one granted camera (listed, but their other cameras stay hidden). */
  cameraSiteIds: string[];
  /** Devices that hold at least one granted camera. */
  cameraDeviceIds: string[];
}

export async function visibleScope(
  tx: Tx,
  t: Pick<TenantContext, "userId" | "role">,
): Promise<VisibleScope | null> {
  if (t.role === "owner" || t.role === "noc") return null;
  const rows = await tx.select().from(cameraGrant).where(eq(cameraGrant.userId, t.userId));
  const siteIds = rows.filter((g) => g.scope === "site").map((g) => g.scopeId);
  const cameraIds = rows.filter((g) => g.scope === "camera").map((g) => g.scopeId);
  const held = cameraIds.length
    ? await tx
        .select({ deviceId: device.id, siteId: device.siteId })
        .from(camera)
        .innerJoin(device, eq(device.id, camera.deviceId))
        .where(inArray(camera.id, cameraIds))
    : [];
  return {
    siteIds,
    cameraIds,
    cameraSiteIds: [...new Set(held.map((h) => h.siteId))],
    cameraDeviceIds: [...new Set(held.map((h) => h.deviceId))],
  };
}

/** Row filters for each inventory table. `undefined` means no restriction. */
export const siteFilter = (s: VisibleScope | null) =>
  s ? or(inArray(site.id, s.siteIds), inArray(site.id, s.cameraSiteIds)) : undefined;
export const deviceFilter = (s: VisibleScope | null) =>
  s ? or(inArray(device.siteId, s.siteIds), inArray(device.id, s.cameraDeviceIds)) : undefined;
/** Needs the camera joined with its device. */
export const cameraFilter = (s: VisibleScope | null) =>
  s ? or(inArray(camera.id, s.cameraIds), inArray(device.siteId, s.siteIds)) : undefined;

/** Operate access on a whole site, for editing it or adding devices to it. Owner and noc pass; viewers never. */
export async function siteAccess(
  tx: Tx,
  t: Pick<TenantContext, "userId" | "role">,
  siteId: string,
): Promise<AccessDecision> {
  if (t.role === "owner" || t.role === "noc") return { allowed: true };
  if (t.role === "viewer") return { allowed: false, reason: "role" };
  const rows = await tx
    .select({ permission: cameraGrant.permission })
    .from(cameraGrant)
    .where(
      and(eq(cameraGrant.userId, t.userId), eq(cameraGrant.scope, "site"), eq(cameraGrant.scopeId, siteId)),
    );
  if (rows.length === 0) return { allowed: false, reason: "no_grant" };
  return rows.some((r) => r.permission === "operate")
    ? { allowed: true }
    : { allowed: false, reason: "view_only" };
}

/** Editing a camera is configuration, not video: noc may, an operator needs an operate grant. */
export async function cameraConfigAccess(
  tx: Tx,
  t: Pick<TenantContext, "orgId" | "userId" | "role">,
  cam: { id: string; siteId: string },
): Promise<AccessDecision> {
  if (t.role === "noc") return { allowed: true };
  return cameraAccess(tx, t, cam, "operate");
}

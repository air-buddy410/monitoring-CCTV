import { type AuditAction, FORBIDDEN_AUDIT_META_KEYS } from "@pantau/contracts";
import { auditLog, newId, type Tx } from "@pantau/db";
import type { TenantContext } from "./tenant";

const FORBIDDEN = new Set<string>(FORBIDDEN_AUDIT_META_KEYS);

function assertSafeMeta(meta: Record<string, unknown>): void {
  for (const k of Object.keys(meta)) {
    if (FORBIDDEN.has(k.toLowerCase())) throw new Error(`forbidden audit meta key: ${k}`);
  }
}

/** Append an audit record inside the caller's tenant transaction. `meta` must never contain secrets. */
export async function writeAudit(
  tx: Tx,
  t: Pick<TenantContext, "orgId" | "userId" | "ip">,
  action: AuditAction,
  target: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  assertSafeMeta(meta);
  await tx.insert(auditLog).values({
    id: newId("aud"),
    organizationId: t.orgId,
    actorId: t.userId,
    action,
    target,
    ip: t.ip,
    meta,
  });
}

/** For actions with no signed-in user (an agent enrolling or connecting); the actor is named in meta. */
export async function writeAuditSystem(
  tx: Tx,
  orgId: string,
  ip: string | null,
  action: AuditAction,
  target: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  assertSafeMeta(meta);
  await tx
    .insert(auditLog)
    .values({ id: newId("aud"), organizationId: orgId, actorId: null, action, target, ip, meta });
}

const CAMERA_ACCESS_ACTIONS = {
  "view.start": "camera.view.start",
  "view.stop": "camera.view.stop",
  ptz: "camera.ptz",
  "playback.start": "camera.playback.start",
  "playback.stop": "camera.playback.stop",
} as const satisfies Record<string, AuditAction>;
export type CameraAccessKind = keyof typeof CAMERA_ACCESS_ACTIONS;

/** One entry point for watching and commanding a camera, so live, PTZ and playback cannot forget to audit. */
export function recordCameraAccess(
  tx: Tx,
  t: Pick<TenantContext, "orgId" | "userId" | "ip">,
  kind: CameraAccessKind,
  cameraId: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  return writeAudit(tx, t, CAMERA_ACCESS_ACTIONS[kind], cameraId, meta);
}

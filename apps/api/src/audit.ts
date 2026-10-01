import { auditLog, newId, type Tx } from "@pantau/db";
import type { TenantContext } from "./tenant";

/** Append an audit record inside the caller's tenant transaction. `meta` must never contain secrets. */
export async function writeAudit(
  tx: Tx,
  t: TenantContext,
  action: string,
  target: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
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

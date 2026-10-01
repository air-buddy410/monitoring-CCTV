import { z } from "zod";

/** Capabilities follow PRD section 7. A capability is never claimed unless it was tested. */
export const CAPABILITIES = [
  "live",
  "snapshot",
  "ptz",
  "ptz.preset",
  "events.motion",
  "playback.search",
  "playback.stream",
  "health",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CapabilityState = z.enum(["ya", "tidak", "belum-diuji"]);
export type CapabilityState = z.infer<typeof CapabilityState>;
export const CapabilityMap = z.record(z.string(), CapabilityState);
export type CapabilityMap = Record<Capability, CapabilityState>;

export const AdapterId = z.enum(["onvif-generic", "hikvision-isapi", "dahua-http"]);

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const IdParams = z.object({ id: z.string().min(1).max(100) });

// ---- sites ----
const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const TimeZone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isTimeZone, "must be an IANA time zone such as Asia/Makassar");
export const SiteCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).optional(),
    timezone: TimeZone.default("Asia/Makassar"),
  })
  .strict();
/** At least one field; `address: null` clears it. Never accepts organization or id fields. */
export const SitePatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().max(300).nullable().optional(),
    timezone: TimeZone.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");
export const Site = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  timezone: z.string(),
  createdAt: z.string(),
});
export const SiteList = z.object({ items: z.array(Site) });

// ---- devices ----
export const HostSchema = z.union([z.ipv4(), z.ipv6()]);

/** Credentials are accepted on input only and never appear in any output schema. */
export const DeviceCreate = z
  .object({
    siteId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    host: HostSchema,
    port: z.number().int().min(1).max(65535).default(80),
    username: z.string().min(1).max(128),
    password: z.string().min(1).max(256),
  })
  .strict();
export type DeviceCreate = z.infer<typeof DeviceCreate>;

export const Device = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  kind: z.enum(["nvr", "ipc"]),
  brand: z.string(),
  model: z.string(),
  firmware: z.string(),
  adapterId: AdapterId,
  host: z.string(),
  port: z.number().int(),
  capabilities: CapabilityMap,
  status: z.string(),
  createdAt: z.string(),
});
export const Camera = z.object({
  id: z.string(),
  deviceId: z.string(),
  siteId: z.string(),
  channel: z.string(),
  name: z.string(),
  hasPtz: z.boolean(),
  mainCodec: z.string().nullable(),
  subCodec: z.string().nullable(),
  status: z.string(),
  sortOrder: z.number().int(),
});
/** Only the name and the position are operator-editable; capabilities come from probing, never from users. */
export const CameraPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");
export const DeviceWithCameras = z.object({ device: Device, cameras: z.array(Camera) });
export const DeviceList = z.object({ items: z.array(Device) });
export const CameraList = z.object({ items: z.array(Camera) });
export const ListQuery = z.object({ siteId: z.string().min(1).max(100).optional() });

// ---- grants (PRD section 8: camera_grant) ----
export const GRANT_SCOPES = ["site", "camera"] as const;
export const GRANT_PERMISSIONS = ["view", "operate"] as const;
export const GrantCreate = z
  .object({
    userId: z.string().min(1).max(100),
    scope: z.enum(GRANT_SCOPES),
    scopeId: z.string().min(1).max(100),
    permission: z.enum(GRANT_PERMISSIONS),
  })
  .strict();
export const Grant = z.object({
  id: z.string(),
  userId: z.string(),
  scope: z.enum(GRANT_SCOPES),
  scopeId: z.string(),
  permission: z.enum(GRANT_PERMISSIONS),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
export const GrantList = z.object({ items: z.array(Grant) });
export const GrantQuery = z.object({
  userId: z.string().min(1).max(100).optional(),
  scope: z.enum(GRANT_SCOPES).optional(),
  scopeId: z.string().min(1).max(100).optional(),
});

// ---- audit ----
/** Every action name that may be written to audit_log. Adding an action means adding it here first. */
export const AUDIT_ACTIONS = [
  "device.create",
  "device.create.failed",
  "camera.snapshot",
  "camera.snapshot.failed",
  "camera.snapshot.denied",
  "camera.update",
  "camera.view.start",
  "camera.view.stop",
  "camera.ptz",
  "camera.playback.start",
  "camera.playback.stop",
  "site.create",
  "site.update",
  "site.delete",
  "grant.create",
  "grant.delete",
  "agent.enrollment.create",
  "agent.enroll",
  "agent.enroll.failed",
  "agent.revoke",
  "agent.inventory.sync",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
/** Keys that must never be stored in audit meta, whatever the caller passes. */
export const FORBIDDEN_AUDIT_META_KEYS = [
  "password",
  "passwd",
  "token",
  "authorization",
  "secret",
  "credentials",
  "credential",
  "rtsp",
  "cookie",
  "apikey",
] as const;
export const AuditItem = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  ip: z.string().nullable(),
  at: z.string(),
  meta: z.record(z.string(), z.unknown()),
});
export const AuditList = z.object({ items: z.array(AuditItem) });
export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: AuditActionSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

// ---- health ----
export const ReadyResponse = z.object({ status: z.literal("ready"), checks: z.array(z.string()) });
export const NotReadyResponse = z.object({ status: z.literal("unavailable"), failed: z.array(z.string()) });

/** Result of probing a device through an adapter. Contains no credentials. */
export interface ProbedChannel {
  channel: string;
  name: string;
  hasPtz: boolean;
  mainCodec: string | null;
  subCodec: string | null;
}
export interface ProbeResult {
  brand: string;
  manufacturer: string;
  model: string;
  firmware: string;
  channels: ProbedChannel[];
  capabilities: CapabilityMap;
}
export type AdapterErrorCode =
  | "device_auth_failed"
  | "device_timeout"
  | "device_unreachable"
  | "device_protocol_error"
  | "snapshot_channel_not_found"
  | "snapshot_uri_host_mismatch"
  | "snapshot_uri_port_not_allowed"
  | "snapshot_invalid_image"
  | "snapshot_failed";

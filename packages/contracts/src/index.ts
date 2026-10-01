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
export const SiteCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).optional(),
    timezone: z.string().trim().min(1).max(64).default("Asia/Makassar"),
  })
  .strict();
export const Site = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  timezone: z.string(),
  createdAt: z.string(),
});
export const SiteList = z.object({ items: z.array(Site) });

/** All fields optional; at least one required. `strict()` rejects unknown keys (e.g. a stray id). */
export const SiteUpdate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    address: z.string().trim().max(300).nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field must be provided");
export type SiteUpdate = z.infer<typeof SiteUpdate>;

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
export const DeviceWithCameras = z.object({ device: Device, cameras: z.array(Camera) });
export const DeviceList = z.object({ items: z.array(Device) });
export const CameraList = z.object({ items: z.array(Camera) });
export const ListQuery = z.object({ siteId: z.string().min(1).max(100).optional() });

/** Camera edits are limited to the display name and manual ordering (channel/device are immutable). */
export const CameraUpdate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field must be provided");
export type CameraUpdate = z.infer<typeof CameraUpdate>;

// ---- audit action vocabulary (PRD F9: viewing and command actions must be auditable) ----
// Reserved now so live/PTZ/playback are audited the moment their routes land.
export const AUDIT_ACTIONS = [
  "device.create",
  "device.create.failed",
  "device.update",
  "device.delete",
  "camera.snapshot",
  "camera.snapshot.failed",
  "camera.update",
  "camera.delete",
  "site.update",
  "site.delete",
  "grant.create",
  "grant.delete",
  "live.start",
  "live.stop",
  "ptz.command",
  "playback.start",
  "playback.stop",
  "agent.enroll",
  "agent.revoke",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ---- audit ----
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
});

// ---- camera grants (PRD F7: per-camera narrowing of the tenant role) ----
export const GrantScope = z.enum(["site", "camera"]);
export const GrantPermission = z.enum(["view", "operate"]);
export const GrantCreate = z
  .object({
    userId: z.string().min(1).max(100),
    scope: GrantScope,
    scopeId: z.string().min(1).max(100),
    permission: GrantPermission,
  })
  .strict();
export type GrantCreate = z.infer<typeof GrantCreate>;
export const Grant = z.object({
  id: z.string(),
  userId: z.string(),
  scope: GrantScope,
  scopeId: z.string(),
  permission: GrantPermission,
  createdAt: z.string(),
});
export type Grant = z.infer<typeof Grant>;
export const GrantList = z.object({ items: z.array(Grant) });

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

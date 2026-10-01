import { z } from "zod";
import { AdapterId, CapabilityMap } from "./primitives";

export * from "./agent";
// Shared vocabulary lives in ./primitives and the agent wire protocol in ./agent; both are re-exported
// here so callers keep a single import site ("@pantau/contracts").
export * from "./primitives";

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
  /** Null for a device added by hand; set to the discovering agent's id (PRD section 8). */
  agentId: z.string().nullable(),
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

// ---- agents (PRD section 8 and 9.1/9.2) ----
export const AGENT_STATUSES = ["pending", "online", "offline", "revoked"] as const;
export const AgentStatus = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** An enrollment is created by owner/noc for one site; it yields a single-use token with a TTL. */
export const AgentEnrollmentCreate = z
  .object({
    siteId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    ttlMinutes: z.number().int().min(1).max(1440).default(60),
  })
  .strict();
export type AgentEnrollmentCreate = z.infer<typeof AgentEnrollmentCreate>;
/** The token is shown once and never stored in clear; it is not part of the persisted record. */
export const AgentEnrollmentCreated = z.object({
  id: z.string(),
  siteId: z.string(),
  token: z.string(),
  expiresAt: z.string(),
});
export const Agent = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  version: z.string(),
  status: AgentStatus,
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export const AgentList = z.object({ items: z.array(Agent) });

/** The agent exchanges its single-use enrollment token for a long-lived agent token. */
export const AgentEnroll = z
  .object({
    token: z.string().min(1).max(300),
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().max(64).default(""),
    publicKey: z.string().max(4000).optional(),
  })
  .strict();
export type AgentEnroll = z.infer<typeof AgentEnroll>;
export const AgentEnrollResult = z.object({ agentId: z.string(), agentToken: z.string() });

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
  "agent.event.received",
  "agent.connect",
  "agent.disconnect",
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

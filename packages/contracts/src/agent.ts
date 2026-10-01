import { z } from "zod";
import { AdapterId, CapabilityMap, HostSchema } from "./common";

/**
 * Agent protocol (PRD section 9.2). Every WebSocket frame is one JSON envelope {id, type, ts, payload}.
 * The agent sends metadata only: no schema here has a field for a device credential, a stream address or a token,
 * and every object is strict, so an extra field is a refusal rather than a silent pass-through.
 */

/** Keys that must never appear anywhere in a frame, checked as a second line of defence on the server. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  "password",
  "passwd",
  "username",
  "credentials",
  "credential",
  "token",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "privateKey",
  "rtsp",
  "rtspUri",
  "streamUri",
  "snapshotUri",
] as const;
const FORBIDDEN = new Set(FORBIDDEN_PAYLOAD_KEYS.map((k) => k.toLowerCase()));

/** True when any object key, at any depth, is on the forbidden list. */
export function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => containsForbiddenKey(v, depth + 1));
  return Object.entries(value).some(
    ([k, v]) => FORBIDDEN.has(k.toLowerCase()) || containsForbiddenKey(v, depth + 1),
  );
}

export const MAX_FRAME_BYTES = 128 * 1024;
/** A snapshot travels in one frame, base64 inside JSON; this is the only message allowed past MAX_FRAME_BYTES. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_FRAME_BYTES = Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4 + 2048;
export const frameLimitFor = (type: string): number =>
  type === "snapshot.request.result" ? MAX_SNAPSHOT_FRAME_BYTES : MAX_FRAME_BYTES;
export const MAX_THUMBNAIL_BYTES = 20 * 1024;
export const MAX_DEVICES_PER_SYNC = 64;
export const MAX_CAMERAS_PER_DEVICE = 128;
/** Per-request timeouts from PRD section 9.2, in milliseconds. */
export const REQUEST_TIMEOUT_MS = {
  "ptz.command": 3000,
  "snapshot.request": 5000,
  "recordings.search": 15000,
} as const;

const Iso = z.iso.datetime({ offset: true });

export const Envelope = z
  .object({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(64),
    ts: Iso,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Envelope = z.infer<typeof Envelope>;

export type ParsedEnvelope =
  | { ok: true; value: Envelope }
  | { ok: false; reason: "too_large" | "not_json" | "invalid_envelope" };

/** Never throws: a hostile peer must not be able to crash the reader with a bad frame. */
export function parseEnvelope(raw: string, maxBytes = MAX_FRAME_BYTES): ParsedEnvelope {
  if (Buffer.byteLength(raw) > maxBytes) return { ok: false, reason: "too_large" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const r = Envelope.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: "invalid_envelope" };
}

const msg = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z
    .object({
      id: z.string().min(1).max(64),
      type: z.literal(type),
      ts: Iso,
      payload,
    })
    .strict();

// ---- agent to api ----
export const Hello = z
  .object({
    agentVersion: z.string().min(1).max(32),
    go2rtcVersion: z.string().max(32).nullable(),
    hostname: z.string().min(1).max(253),
  })
  .strict();

const DeviceKey = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, "deviceKey: letters, digits, . _ : - only");
export const InventoryCamera = z
  .object({
    channel: z.string().min(1).max(32),
    name: z.string().trim().min(1).max(120),
    hasPtz: z.boolean(),
    mainCodec: z.string().max(32).nullable(),
    subCodec: z.string().max(32).nullable(),
  })
  .strict();
export const InventoryDevice = z
  .object({
    deviceKey: DeviceKey,
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["nvr", "ipc"]),
    brand: z.string().max(64),
    model: z.string().max(128),
    firmware: z.string().max(128),
    adapterId: AdapterId,
    host: HostSchema,
    port: z.number().int().min(1).max(65535),
    capabilities: CapabilityMap,
    cameras: z
      .array(InventoryCamera)
      .max(MAX_CAMERAS_PER_DEVICE)
      .refine((c) => new Set(c.map((x) => x.channel)).size === c.length, "duplicate channel"),
  })
  .strict();
export const InventorySync = z
  .object({
    devices: z
      .array(InventoryDevice)
      .max(MAX_DEVICES_PER_SYNC)
      .refine((d) => new Set(d.map((x) => x.deviceKey)).size === d.length, "duplicate deviceKey"),
  })
  .strict();
export type InventorySync = z.infer<typeof InventorySync>;

const Percent = z.number().min(0).max(100);
export const StatusReport = z
  .object({
    cameras: z
      .array(
        z.object({ deviceKey: DeviceKey, channel: z.string().min(1).max(32), online: z.boolean() }).strict(),
      )
      .max(MAX_DEVICES_PER_SYNC * MAX_CAMERAS_PER_DEVICE),
    cpuPercent: Percent,
    memUsedPercent: Percent,
    diskUsedPercent: Percent,
    uptimeSec: z.number().int().min(0).optional(),
  })
  .strict();
export type StatusReport = z.infer<typeof StatusReport>;

const decodedBytes = (b64: string) =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
export const MotionEvent = z
  .object({
    deviceKey: DeviceKey,
    channel: z.string().min(1).max(32),
    at: Iso,
    thumbnailBase64: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((s) => decodedBytes(s) <= MAX_THUMBNAIL_BYTES, "thumbnail over 20 KB"),
  })
  .strict();

const CommandResult = z.object({ ok: z.boolean(), code: z.string().max(64).optional() }).strict();
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const SnapshotResult = z
  .object({
    ok: z.boolean(),
    code: z.string().max(64).optional(),
    jpegBase64: z
      .string()
      .regex(BASE64)
      .refine((b) => decodedBytes(b) <= MAX_SNAPSHOT_BYTES, "snapshot over 1 MiB")
      .optional(),
  })
  .strict()
  .refine(
    (r) => (r.ok ? r.jpegBase64 !== undefined : r.jpegBase64 === undefined),
    "ok carries the image, a failure does not",
  );

export const AgentInbound = z.discriminatedUnion("type", [
  msg("hello", Hello),
  msg("inventory.sync", InventorySync),
  msg("status", StatusReport),
  msg("event.motion", MotionEvent),
  msg("ptz.command.result", CommandResult),
  msg("snapshot.request.result", SnapshotResult),
]);
export type AgentInbound = z.infer<typeof AgentInbound>;

// ---- api to agent ----
const PtzCommand = z
  .object({
    deviceKey: DeviceKey,
    channel: z.string().min(1).max(32),
    action: z.enum(["move", "stop", "zoom", "preset"]),
    x: z.number().min(-1).max(1).optional(),
    y: z.number().min(-1).max(1).optional(),
    z: z.number().min(-1).max(1).optional(),
    presetToken: z.string().min(1).max(64).optional(),
  })
  .strict();
const SnapshotRequest = z.object({ deviceKey: DeviceKey, channel: z.string().min(1).max(32) }).strict();

export const AgentOutbound = z.discriminatedUnion("type", [
  msg("ack", z.record(z.string(), z.unknown())),
  msg("error", z.object({ code: z.string().min(1).max(64), message: z.string().max(200) }).strict()),
  msg("ptz.command", PtzCommand),
  msg("snapshot.request", SnapshotRequest),
]);
export type AgentOutbound = z.infer<typeof AgentOutbound>;

// ---- REST: enrollment and agents (PRD sections 4.5 and 9.1) ----
/** Enrollment tokens are single use and live 24 hours (PRD section 4.5). */
export const ENROLLMENT_TTL_HOURS = 24;
export const EnrollmentCreate = z.object({}).strict();
export const EnrollmentResponse = z.object({
  id: z.string(),
  siteId: z.string(),
  /** Shown once. Only its hash is stored. */
  token: z.string(),
  expiresAt: z.string(),
});

/** Ed25519 public key, SPKI DER, base64. */
export const AgentEnrollRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    publicKey: z.string().min(40).max(200),
    hostname: z.string().min(1).max(253).optional(),
    agentVersion: z.string().min(1).max(32).optional(),
  })
  .strict();
export const AgentEnrollResponse = z.object({
  agentId: z.string(),
  siteId: z.string(),
  /** Long-lived, revocable, shown once. Only its hash is stored. */
  agentToken: z.string(),
  websocketPath: z.literal("/agent"),
});

export const AGENT_STATUSES = ["online", "offline", "revoked"] as const;
export const Agent = z.object({
  id: z.string(),
  siteId: z.string(),
  name: z.string(),
  version: z.string(),
  go2rtcVersion: z.string().nullable(),
  hostname: z.string(),
  status: z.enum(AGENT_STATUSES),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  /** First 16 hex characters of the SHA-256 of the public key. */
  publicKeyFingerprint: z.string(),
  lastStatus: z
    .object({
      cpuPercent: z.number(),
      memUsedPercent: z.number(),
      diskUsedPercent: z.number(),
      uptimeSec: z.number().optional(),
      camerasOnline: z.number().int(),
      camerasTotal: z.number().int(),
      at: z.string(),
    })
    .nullable(),
});
export const AgentList = z.object({ items: z.array(Agent) });

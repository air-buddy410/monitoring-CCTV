import { z } from "zod";
import { AdapterId, CapabilityMap } from "./primitives";

/**
 * Agent wire protocol (PRD section 9.2). Every message is an envelope; `id` correlates a request with
 * its `*.result` reply, so the server can time out a request instead of waiting forever.
 */
export const AgentEnvelope = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  ts: z.string().min(1).max(40),
  payload: z.unknown(),
});
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;

export const AGENT_INBOUND_TYPES = [
  "hello",
  "inventory.sync",
  "status",
  "event.motion",
  "live.answer",
  "ice",
  "ptz.result",
  "snapshot.result",
  "recordings.result",
  "pong",
] as const;
export const AGENT_OUTBOUND_TYPES = [
  "hello.ack",
  "ping",
  "inventory.ack",
  "live.offer",
  "live.stop",
  "playback.start",
  "playback.stop",
  "ptz.command",
  "snapshot.request",
  "recordings.search",
  "ice",
  "error",
] as const;

/** Per-message deadlines (PRD section 9.2). Nothing waits forever. */
export const AGENT_TIMEOUTS_MS = {
  ptz: 3000,
  snapshot: 5000,
  recordings: 15_000,
  live: 10_000,
} as const;
export type AgentRequestKind = keyof typeof AGENT_TIMEOUTS_MS;

export const AgentHello = z
  .object({
    version: z.string().trim().max(64).default(""),
    go2rtcVersion: z.string().trim().max(64).optional(),
    hostname: z.string().trim().max(255).optional(),
  })
  .strict();
export type AgentHello = z.infer<typeof AgentHello>;

/** Metadata only: credentials stay in the agent vault and are never sent (PRD section 9.2). */
export const AgentInventoryCamera = z
  .object({
    channel: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    hasPtz: z.boolean().default(false),
    mainCodec: z.string().trim().max(32).nullable().optional(),
    subCodec: z.string().trim().max(32).nullable().optional(),
    status: z.enum(["online", "offline"]).default("online"),
    sortOrder: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const AgentInventoryDevice = z
  .object({
    /** Stable per-agent identity (serial or host:port); the server matches rows by it. */
    key: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["nvr", "ipc"]),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    brand: z.string().trim().max(64).default(""),
    model: z.string().trim().max(120).default(""),
    firmware: z.string().trim().max(120).default(""),
    adapterId: AdapterId,
    capabilities: CapabilityMap.optional(),
    status: z.enum(["online", "offline"]).default("online"),
    cameras: z.array(AgentInventoryCamera).max(256).default([]),
  })
  .strict();
export type AgentInventoryDevice = z.infer<typeof AgentInventoryDevice>;

export const AgentInventorySync = z
  .object({
    devices: z.array(AgentInventoryDevice).max(200),
  })
  .strict();
export type AgentInventorySync = z.infer<typeof AgentInventorySync>;

/** Renamed from `AgentStatus` because the registry already exports an `AgentStatus` enum. */
export const AgentStatusReport = z
  .object({
    cpuPct: z.number().min(0).max(100).optional(),
    memPct: z.number().min(0).max(100).optional(),
    diskPct: z.number().min(0).max(100).optional(),
    go2rtcVersion: z.string().trim().max(64).optional(),
    cameras: z
      .array(
        z
          .object({
            deviceKey: z.string().trim().min(1).max(200),
            channel: z.string().trim().min(1).max(64),
            status: z.enum(["online", "offline"]),
          })
          .strict(),
      )
      .max(512)
      .default([]),
  })
  .strict();
export type AgentStatusReport = z.infer<typeof AgentStatusReport>;

export const AgentHelloAck = z.object({
  agentId: z.string(),
  siteId: z.string(),
  heartbeatMs: z.number().int(),
});
export const AgentInventoryAck = z.object({
  devices: z.number().int(),
  cameras: z.number().int(),
});
export const AgentError = z.object({
  code: z.string(),
  detail: z.string().optional(),
});
export type AgentError = z.infer<typeof AgentError>;

/** Reply shape per request kind, used by the server to answer a `*.result` back to its caller. */
export const AgentPtzCommand = z
  .object({
    cameraId: z.string().min(1).max(100),
    action: z.enum(["left", "right", "up", "down", "zoom-in", "zoom-out", "stop", "preset"]),
    preset: z.string().trim().max(64).optional(),
    speed: z.number().min(0).max(1).optional(),
  })
  .strict();
export const AgentSnapshotRequest = z.object({ cameraId: z.string().min(1).max(100) }).strict();
export const AgentRecordingsSearch = z
  .object({
    cameraId: z.string().min(1).max(100),
    from: z.string().min(1).max(40),
    to: z.string().min(1).max(40),
  })
  .strict();

/** What a caller of the hub waits for; `id` is the envelope id it must echo back. */
export interface AgentRequestSpec {
  kind: AgentRequestKind;
  type: string;
  payload: unknown;
}

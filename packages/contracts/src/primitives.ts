import { z } from "zod";

/**
 * Shared vocabulary used by both the REST contracts and the agent wire protocol. It lives in its own
 * module so `agent.ts` does not have to import the barrel that re-exports it (no import cycle).
 */

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
export type AdapterId = z.infer<typeof AdapterId>;

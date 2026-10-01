import { AdapterError, type DeviceConn, onvifGenericAdapter } from "@pantau/adapters";
import { MAX_SNAPSHOT_BYTES } from "@pantau/contracts";
import { z } from "zod";
import type { CommandResult } from "./client";
import type { Credentials } from "./vault";

const Request = z.object({ deviceKey: z.string().min(1), channel: z.string().min(1) });

export interface SnapshotDeps {
  registry: {
    list(): { deviceKey: string; host: string; port: number; cameras: { channel: string }[] }[];
    credentialsFor(deviceKey: string): Credentials | null;
  };
  timeoutMs: number;
  /** Replaceable for tests; the default is the read-only ONVIF snapshot with host pinning and a JPEG check. */
  snapshot?: (conn: DeviceConn, channel: string) => Promise<Buffer>;
}

/**
 * `snapshot.request` on the agent: the device address and credentials come from the local registry and vault, never
 * from the message, and only a stable error code goes back, because library messages can echo what was sent.
 */
export function makeSnapshotHandler(d: SnapshotDeps) {
  const take = d.snapshot ?? ((conn, channel) => onvifGenericAdapter.snapshot(conn, channel));
  return async (payload: Record<string, unknown>): Promise<CommandResult> => {
    const req = Request.safeParse(payload);
    if (!req.success) return { ok: false, code: "invalid_request" };
    const device = d.registry.list().find((x) => x.deviceKey === req.data.deviceKey);
    if (!device) return { ok: false, code: "device_not_found" };
    if (!device.cameras.some((c) => c.channel === req.data.channel))
      return { ok: false, code: "snapshot_channel_not_found" };
    const creds = d.registry.credentialsFor(device.deviceKey);
    if (!creds) return { ok: false, code: "device_auth_failed" };
    try {
      const jpeg = await take(
        {
          host: device.host,
          port: device.port,
          username: creds.username,
          password: creds.password,
          timeoutMs: d.timeoutMs,
        },
        req.data.channel,
      );
      if (jpeg.length > MAX_SNAPSHOT_BYTES) return { ok: false, code: "snapshot_too_large" };
      return { ok: true, jpegBase64: jpeg.toString("base64") };
    } catch (e) {
      return { ok: false, code: e instanceof AdapterError ? e.code : "snapshot_failed" };
    }
  };
}

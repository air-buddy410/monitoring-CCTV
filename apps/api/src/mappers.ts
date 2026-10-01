import type { Camera, Device } from "@pantau/contracts";
import type { camera, device } from "@pantau/db";
import type { z } from "zod";

type DeviceRow = typeof device.$inferSelect;
type CameraRow = typeof camera.$inferSelect;

export function toDevice(r: DeviceRow): z.infer<typeof Device> {
  return {
    id: r.id,
    siteId: r.siteId,
    name: r.name,
    kind: r.kind as "nvr" | "ipc",
    brand: r.brand,
    model: r.model,
    firmware: r.firmware,
    adapterId: r.adapterId as "onvif-generic",
    host: r.host,
    port: r.port,
    capabilities: r.capabilities as Record<string, "ya" | "tidak" | "belum-diuji">,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toCamera(r: CameraRow, siteId: string): z.infer<typeof Camera> {
  return {
    id: r.id,
    deviceId: r.deviceId,
    siteId,
    channel: r.channel,
    name: r.name,
    hasPtz: r.hasPtz,
    mainCodec: r.mainCodec,
    subCodec: r.subCodec,
    status: r.status,
    sortOrder: r.sortOrder,
  };
}

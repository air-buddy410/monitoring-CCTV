import type { Camera, Device } from "@pantau/contracts";
import type { z } from "zod";

export type DeviceT = z.infer<typeof Device>;
export type CameraT = z.infer<typeof Camera>;

export interface Filters {
  q: string;
  siteId: string;
  kind: "" | "nvr" | "ipc";
  cap: "" | "ptz" | "snapshot";
}
export const EMPTY_FILTERS: Filters = { q: "", siteId: "", kind: "", cap: "" };

export const isFiltering = (f: Filters) => f.q.trim() !== "" || f.siteId !== "" || f.kind !== "" || f.cap !== "";

/** Search only fields the API really returns. Case-insensitive, every word must match somewhere. */
export function filterDevices(devices: DeviceT[], f: Filters, camerasByDevice: Map<string, CameraT[]>): DeviceT[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return devices.filter((d) => {
    if (f.siteId && d.siteId !== f.siteId) return false;
    if (f.kind && d.kind !== f.kind) return false;
    if (f.cap && d.capabilities[f.cap] !== "ya") return false;
    if (words.length === 0) return true;
    const cams = camerasByDevice.get(d.id) ?? [];
    const hay = [d.name, d.brand, d.model, d.firmware, d.host, ...cams.map((c) => c.name)].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

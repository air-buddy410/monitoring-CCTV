"use client";

import { Camera, CameraList, Device, DeviceList, Site, SiteList } from "@pantau/contracts";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { ApiError, getJson } from "@/lib/api";

export type SiteT = z.infer<typeof Site>;
export type DeviceT = z.infer<typeof Device>;
export type CameraT = z.infer<typeof Camera>;

export type WorkspaceData =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; devices: DeviceT[]; cameras: CameraT[]; sites: SiteT[] };

/** Three real list calls in parallel. The camera list already carries deviceId and siteId, so no per-device requests. */
export function useWorkspaceData(): { data: WorkspaceData; reload: () => Promise<void> } {
  const [data, setData] = useState<WorkspaceData>({ status: "loading" });
  const load = useCallback(async () => {
    try {
      const [d, c, s] = await Promise.all([
        getJson("/v1/devices", DeviceList),
        getJson("/v1/cameras", CameraList),
        getJson("/v1/sites", SiteList),
      ]);
      setData({ status: "ready", devices: d.items, cameras: c.items, sites: s.items });
    } catch (e) {
      setData({ status: "error", error: e instanceof ApiError ? e : new ApiError(0, "network_error") });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, reload: load };
}

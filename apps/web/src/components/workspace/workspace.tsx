"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/session";
import { StateBlock } from "@/components/ui";
import { ApiError, postSnapshot } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { AddDeviceDialog } from "./add-device-dialog";
import { CameraSlots } from "./camera-slots";
import { useWorkspaceData } from "./data";
import { DeviceRail } from "./device-rail";
import { ProbeSheet } from "./probe-sheet";
import { type ShotState, SnapshotStage } from "./snapshot-stage";

export function Workspace() {
  const { role } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const deviceId = params.get("d");
  const cameraParam = params.get("c");
  const { data, reload } = useWorkspaceData();
  const [adding, setAdding] = useState(false);
  const [shots, setShots] = useState<Record<string, ShotState>>({});
  const urls = useRef(new Set<string>());

  useEffect(() => {
    const live = urls.current;
    return () => {
      for (const u of live) URL.revokeObjectURL(u);
    };
  }, []);

  const take = useCallback(async (cameraId: string) => {
    setShots((p) => ({ ...p, [cameraId]: { status: "loading" } }));
    try {
      const frame = await postSnapshot(`/v1/cameras/${cameraId}/snapshot`);
      urls.current.add(frame.url);
      setShots((p) => {
        const old = p[cameraId];
        if (old?.status === "ready") {
          URL.revokeObjectURL(old.frame.url);
          urls.current.delete(old.frame.url);
        }
        return { ...p, [cameraId]: { status: "ready", frame } };
      });
    } catch (error) {
      const retryUntil =
        error instanceof ApiError && error.status === 429 && error.retryAfterSec
          ? Date.now() + error.retryAfterSec * 1000
          : undefined;
      setShots((p) => {
        const old = p[cameraId];
        if (old?.status === "ready") {
          URL.revokeObjectURL(old.frame.url);
          urls.current.delete(old.frame.url);
        }
        return { ...p, [cameraId]: { status: "error", error, retryUntil } };
      });
    }
  }, []);

  const view = useMemo(() => {
    if (data.status !== "ready" || !deviceId) return null;
    const device = data.devices.find((d) => d.id === deviceId);
    if (!device) return { missing: true as const };
    const cameras = data.cameras.filter((c) => c.deviceId === device.id);
    const camera = cameras.find((c) => c.id === cameraParam) ?? cameras[0];
    return {
      missing: false as const,
      device,
      cameras,
      camera,
      site: data.sites.find((s) => s.id === device.siteId),
    };
  }, [data, deviceId, cameraParam]);

  if (data.status === "loading")
    return <StateBlock kind="loading" title="Memuat perangkat, kamera, dan lokasi…" />;
  if (data.status === "error") {
    const m = describeError(data.error);
    return (
      <StateBlock
        kind={data.error instanceof ApiError && data.error.status === 403 ? "forbidden" : "error"}
        title={m.title}
        hint={m.hint}
        action={
          <button type="button" className="btn" onClick={() => void reload()}>
            Coba lagi
          </button>
        }
      />
    );
  }

  const selected = Boolean(deviceId);
  return (
    <>
      {selected ? (
        <p className="mb-3 min-[720px]:hidden">
          <Link href="/perangkat" className="btn">
            Kembali ke daftar
          </Link>
        </p>
      ) : null}
      <div
        className={`grid gap-6 min-[720px]:grid-cols-[300px_minmax(0,1fr)] min-[1200px]:grid-cols-[320px_minmax(0,1fr)_340px] ${selected ? "max-[719px]:pb-44" : ""}`}
      >
        <div className="min-w-0 min-[720px]:col-start-1 min-[720px]:row-span-2 min-[720px]:row-start-1 min-[1200px]:row-span-1">
          <DeviceRail
            devices={data.devices}
            cameras={data.cameras}
            sites={data.sites}
            role={role}
            selectedId={deviceId}
            onAdd={() => setAdding(true)}
            hiddenOnNarrow={selected}
          />
        </div>

        <div
          className={`min-w-0 min-[720px]:col-start-2 min-[720px]:row-start-1 ${selected ? "" : "max-[719px]:hidden"}`}
        >
          {!selected ? (
            <StateBlock
              kind="empty"
              title="Pilih perangkat di daftar."
              hint="Snapshot dan lembar probe perangkat yang dipilih tampil di sini."
            />
          ) : view?.missing ? (
            <StateBlock
              kind="error"
              title="Perangkat ini tidak ditemukan di organisasi aktif."
              hint="Mungkin milik organisasi lain atau sudah tidak ada."
              action={
                <Link href="/perangkat" className="btn">
                  Kembali ke daftar
                </Link>
              }
            />
          ) : view?.camera ? (
            <>
              <SnapshotStage
                camera={view.camera}
                role={role}
                shot={shots[view.camera.id] ?? { status: "idle" }}
                onTake={() => void take((view.camera as { id: string }).id)}
              />
              <CameraSlots
                deviceId={view.device.id}
                cameras={view.cameras}
                selectedId={view.camera.id}
                shots={shots}
              />
            </>
          ) : view ? (
            <StateBlock
              kind="empty"
              title="Perangkat ini belum punya kamera."
              hint="Probe tidak menemukan kanal video."
            />
          ) : null}
        </div>

        {view && !view.missing ? (
          <div className="min-w-0 min-[720px]:col-start-2 min-[720px]:row-start-2 min-[1200px]:col-start-3 min-[1200px]:row-start-1">
            <ProbeSheet device={view.device} site={view.site} />
          </div>
        ) : null}
      </div>

      <AddDeviceDialog
        key={adding ? "open" : "closed"}
        open={adding}
        onClose={() => setAdding(false)}
        sites={data.sites}
        onCreated={(id) => {
          setAdding(false);
          void reload();
          router.push(`/perangkat?d=${id}`);
        }}
      />
    </>
  );
}

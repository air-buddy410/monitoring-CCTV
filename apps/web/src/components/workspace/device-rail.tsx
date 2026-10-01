"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { GlyphSearch } from "@/components/glyphs";
import { Dialog, StateBlock, useMediaQuery } from "@/components/ui";
import { EMPTY_FILTERS, type Filters, filterDevices, isFiltering } from "@/lib/filters";
import { can, type Role } from "@/lib/roles";
import type { CameraT, DeviceT, SiteT } from "./data";

function FilterControls({ f, set, sites }: { f: Filters; set: (n: Filters) => void; sites: SiteT[] }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor="f-lokasi">
          Lokasi
        </label>
        <select
          id="f-lokasi"
          className="field"
          value={f.siteId}
          onChange={(e) => set({ ...f, siteId: e.target.value })}
        >
          <option value="">Semua lokasi</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="f-jenis">
            Jenis
          </label>
          <select
            id="f-jenis"
            className="field"
            value={f.kind}
            onChange={(e) => set({ ...f, kind: e.target.value as Filters["kind"] })}
          >
            <option value="">Semua</option>
            <option value="nvr">NVR</option>
            <option value="ipc">Kamera tunggal</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-cap">
            Kemampuan
          </label>
          <select
            id="f-cap"
            className="field"
            value={f.cap}
            onChange={(e) => set({ ...f, cap: e.target.value as Filters["cap"] })}
          >
            <option value="">Semua</option>
            <option value="snapshot">Snapshot terbukti</option>
            <option value="ptz">PTZ terdeteksi</option>
          </select>
        </div>
      </div>
    </div>
  );
}

interface Props {
  devices: DeviceT[];
  cameras: CameraT[];
  sites: SiteT[];
  role: Role | null;
  selectedId: string | null;
  onAdd: () => void;
  hiddenOnNarrow: boolean;
}

export function DeviceRail({ devices, cameras, sites, role, selectedId, onAdd, hiddenOnNarrow }: Props) {
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [sheet, setSheet] = useState(false);
  const wide = useMediaQuery("(min-width: 720px)");
  const camsByDevice = useMemo(() => {
    const m = new Map<string, CameraT[]>();
    for (const c of cameras) m.set(c.deviceId, [...(m.get(c.deviceId) ?? []), c]);
    return m;
  }, [cameras]);
  const shown = useMemo(() => filterDevices(devices, f, camsByDevice), [devices, f, camsByDevice]);
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const activeCount = [f.siteId, f.kind, f.cap].filter(Boolean).length;

  return (
    <section
      aria-labelledby="rail-title"
      className={`${hiddenOnNarrow ? "hidden min-[720px]:block" : ""} min-w-0`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="rail-title" className="h-section">
          Perangkat
        </h2>
        {can.addDevice(role) ? (
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            Tambah perangkat
          </button>
        ) : null}
      </div>

      {devices.length > 0 ? (
        <div className="mt-3 space-y-3">
          <div>
            <label className="label" htmlFor="cari">
              Cari perangkat
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                <GlyphSearch />
              </span>
              <input
                id="cari"
                type="search"
                className="field pl-10"
                placeholder="Nama, merek, model, alamat"
                value={f.q}
                onChange={(e) => setF({ ...f, q: e.target.value })}
              />
            </div>
          </div>
          {wide ? (
            <FilterControls f={f} set={setF} sites={sites} />
          ) : (
            <>
              <button type="button" className="btn w-full" onClick={() => setSheet(true)}>
                Saring{activeCount ? ` (${activeCount} aktif)` : ""}
              </button>
              <Dialog open={sheet} onClose={() => setSheet(false)} title="Saring perangkat">
                <div className="space-y-3 overflow-y-auto p-4">
                  <FilterControls f={f} set={setF} sites={sites} />
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-primary" onClick={() => setSheet(false)}>
                      Lihat {shown.length} perangkat
                    </button>
                    <button type="button" className="btn" onClick={() => setF(EMPTY_FILTERS)}>
                      Hapus saringan
                    </button>
                  </div>
                </div>
              </Dialog>
            </>
          )}
          <p className="text-muted" aria-live="polite">
            {isFiltering(f)
              ? `${shown.length} dari ${devices.length} perangkat cocok.`
              : `${devices.length} perangkat.`}
          </p>
        </div>
      ) : null}

      <div className="mt-3">
        {devices.length === 0 ? (
          <StateBlock
            kind="empty"
            title="Belum ada perangkat di organisasi ini."
            hint={
              can.addDevice(role)
                ? "Siapkan alamat IP, port ONVIF, dan kredensial perangkat. Saat ditambahkan, PANTAU langsung melakukan probe."
                : "Peran Anda hanya dapat melihat. Minta operator menambahkan perangkat."
            }
            action={
              can.addDevice(role) ? (
                <button type="button" className="btn btn-primary" onClick={onAdd}>
                  Tambah perangkat
                </button>
              ) : undefined
            }
          />
        ) : shown.length === 0 ? (
          <StateBlock
            kind="empty"
            title="Tidak ada perangkat yang cocok dengan saringan ini."
            hint="Ubah kata kunci atau hapus saringan."
            action={
              <button type="button" className="btn" onClick={() => setF(EMPTY_FILTERS)}>
                Hapus saringan
              </button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {shown.map((d) => {
              const n = camsByDevice.get(d.id)?.length ?? 0;
              const active = d.id === selectedId;
              return (
                <li key={d.id}>
                  <Link
                    href={`/perangkat?d=${d.id}`}
                    aria-current={active ? "true" : undefined}
                    className={`block min-h-11 border-2 p-3 ${active ? "border-accent-ink bg-raised" : "border-hair bg-panel hover:border-line"}`}
                  >
                    <span className="block font-bold">{d.name}</span>
                    <span className="block text-muted">
                      {d.brand || d.model ? (
                        <>
                          <span className="capitalize">{d.brand}</span>
                          {d.brand && d.model ? " " : ""}
                          {d.model}
                        </>
                      ) : (
                        "Merek tidak dilaporkan"
                      )}
                    </span>
                    <span className="mono block text-muted">
                      {d.host}:{d.port}
                    </span>
                    <span className="block text-muted">
                      {siteName(d.siteId)} · {n} kamera
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

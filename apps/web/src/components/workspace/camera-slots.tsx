"use client";

import Link from "next/link";
import { formatClock } from "@/lib/format";
import type { ShotState } from "./snapshot-stage";
import type { CameraT } from "./data";

interface Props {
  deviceId: string;
  cameras: CameraT[];
  selectedId: string;
  shots: Record<string, ShotState>;
}

/** One slot per camera of the device. A thumbnail appears only for frames taken in this browser session. */
export function CameraSlots({ deviceId, cameras, selectedId, shots }: Props) {
  return (
    <section aria-labelledby="slots-title" className="mt-8">
      <h2 id="slots-title" className="h-section">
        Kamera ({cameras.length})
      </h2>
      <ul className="mt-4 grid gap-4 px-2 min-[520px]:grid-cols-2 min-[1200px]:grid-cols-3">
        {cameras.map((c) => {
          const s = shots[c.id];
          const active = c.id === selectedId;
          return (
            <li key={c.id}>
              <Link
                href={`/perangkat?d=${deviceId}&c=${c.id}`}
                aria-current={active ? "true" : undefined}
                className="crop block min-h-11 bg-panel"
                data-active={active ? "true" : "false"}
              >
                <span className="flex aspect-video items-center justify-center overflow-hidden bg-[var(--viewer-bg)]">
                  {s?.status === "ready" ? (
                    // biome-ignore lint/performance/noImgElement: blob URL thumbnail
                    <img src={s.frame.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="mono px-2 text-center text-[var(--viewer-text)]">Belum diambil</span>
                  )}
                </span>
                <span className="block p-2">
                  <span className={`block ${active ? "font-extrabold" : "font-bold"}`}>
                    {c.name}
                    {active ? " (dipilih)" : ""}
                  </span>
                  <span className="mono block text-muted">kanal {c.channel}</span>
                  <span className="block text-muted">
                    {c.hasPtz ? "PTZ terdeteksi" : "Tanpa PTZ"}
                    {s?.status === "ready" ? ` · diterima ${formatClock(s.frame.receivedAt)}` : ""}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

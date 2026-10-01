"use client";

import { useEffect, useState } from "react";
import { GlyphDownload, GlyphExpand, GlyphRepeat } from "@/components/glyphs";
import { Dialog, StateBlock } from "@/components/ui";
import type { Frame } from "@/lib/api";
import { describeError, type Message } from "@/lib/errors";
import { formatBytes, formatClock } from "@/lib/format";
import { can, type Role } from "@/lib/roles";
import type { CameraT } from "./data";

export type ShotState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown; retryUntil?: number }
  | { status: "ready"; frame: Frame };

interface Props {
  camera: CameraT;
  role: Role | null;
  shot: ShotState;
  onTake: () => void;
}

function useCountdown(until?: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function SnapshotStage({ camera, role, shot, onTake }: Props) {
  const [full, setFull] = useState(false);
  const [broken, setBroken] = useState(false);
  const retryIn = useCountdown(shot.status === "error" ? shot.retryUntil : undefined);
  const frameUrl = shot.status === "ready" ? shot.frame.url : null;
  useEffect(() => setBroken(false), [frameUrl]);

  const allowed = can.snapshot(role);
  const busy = shot.status === "loading";
  const showFrame = shot.status === "ready" && !broken;
  const message: Message | null =
    shot.status === "error"
      ? describeError(shot.error)
      : broken
        ? { title: "Gambar tidak dapat ditampilkan." }
        : null;
  const shotLabel = shot.status === "ready" ? "Ambil snapshot lagi" : "Ambil snapshot";
  const fileName =
    shot.status === "ready"
      ? `pantau-${camera.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${shot.frame.receivedAt.toISOString().slice(0, 19).replace(/[:T]/g, "")}.jpg`
      : "snapshot.jpg";

  return (
    <section aria-labelledby="stage-title" className="min-w-0">
      <h2 id="stage-title" className="h-section">
        Snapshot: {camera.name}
      </h2>
      <figure className="crop m-0 mx-2 mt-4" data-active={showFrame ? "true" : "false"}>
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-[var(--viewer-bg)] text-[var(--viewer-text)]">
          {showFrame && shot.status === "ready" ? (
            <img
              src={shot.frame.url}
              alt={`Snapshot kamera ${camera.name}, diterima pukul ${formatClock(shot.frame.receivedAt)}`}
              className="h-full w-full object-contain"
              onError={() => setBroken(true)}
            />
          ) : (
            <div className="w-full p-4">
              {busy ? (
                <StateBlock
                  kind="loading"
                  title="Meminta snapshot dari perangkat…"
                  hint="Biasanya selesai dalam beberapa detik. Batas waktunya diatur server."
                />
              ) : message ? (
                <StateBlock
                  kind={message.title.startsWith("Peran") ? "forbidden" : "error"}
                  title={message.title}
                  hint={message.hint}
                />
              ) : (
                <StateBlock
                  kind="empty"
                  title="Belum ada snapshot untuk kamera ini."
                  hint={
                    allowed
                      ? "Tekan Ambil snapshot untuk meminta satu gambar dari perangkat. Ini bukan video langsung."
                      : "Peran Anda hanya dapat melihat data. Mengambil snapshot memerlukan peran operator."
                  }
                />
              )}
            </div>
          )}
        </div>
        <figcaption className="mono flex flex-wrap justify-between gap-x-4 border border-t-0 border-line bg-raised px-3 py-2 text-ink">
          <span>
            Kanal {camera.channel} · utama {camera.mainCodec ?? "tidak dilaporkan"} · sub{" "}
            {camera.subCodec ?? "tidak dilaporkan"}
          </span>
          <span>
            {showFrame && shot.status === "ready"
              ? `Diterima di browser ${formatClock(shot.frame.receivedAt)} · ${formatBytes(shot.frame.bytes)}`
              : "Belum ada gambar"}
          </span>
        </figcaption>
      </figure>

      <div
        className="mt-4 flex flex-wrap gap-2 max-[719px]:fixed max-[719px]:grid max-[719px]:grid-cols-2 max-[719px]:inset-x-0 max-[719px]:bottom-0 max-[719px]:z-10 max-[719px]:mt-0 max-[719px]:border-t max-[719px]:border-hair max-[719px]:bg-panel max-[719px]:p-3 max-[719px]:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        role="group"
        aria-label="Aksi snapshot"
      >
        {allowed ? (
          <button
            type="button"
            className="btn btn-primary max-[719px]:col-span-2"
            onClick={onTake}
            disabled={busy || retryIn > 0}
            aria-busy={busy}
          >
            <GlyphRepeat />
            {busy ? "Mengambil…" : retryIn > 0 ? `${shotLabel} (tunggu ${retryIn} dtk)` : shotLabel}
          </button>
        ) : null}
        <button type="button" className="btn" onClick={() => setFull(true)} disabled={!showFrame}>
          <GlyphExpand />
          Layar penuh
        </button>
        {showFrame && shot.status === "ready" ? (
          <a className="btn" href={shot.frame.url} download={fileName}>
            <GlyphDownload />
            Unduh JPEG
          </a>
        ) : null}
      </div>

      <Dialog
        open={full}
        onClose={() => setFull(false)}
        title={`Snapshot ${camera.name}`}
        bare
        className="viewer"
      >
        <div className="flex h-dvh flex-col">
          <div className="flex items-center justify-between gap-3 p-3">
            <p className="mono">
              {camera.name} · kanal {camera.channel}
              {shot.status === "ready" ? ` · diterima ${formatClock(shot.frame.receivedAt)}` : ""}
            </p>
            <button type="button" className="btn" onClick={() => setFull(false)}>
              Tutup layar penuh
            </button>
          </div>
          <div className="min-h-0 flex-1 p-3 pt-0">
            {shot.status === "ready" ? (
              <img
                src={shot.frame.url}
                alt={`Snapshot kamera ${camera.name}`}
                className="h-full w-full object-contain"
              />
            ) : null}
          </div>
        </div>
      </Dialog>
    </section>
  );
}

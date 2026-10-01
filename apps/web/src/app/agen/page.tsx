"use client";

import { Agent, AgentList, EnrollmentResponse, SiteList } from "@pantau/contracts";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import { StateGlyph } from "@/components/glyphs";
import { useSession } from "@/components/session";
import { AppFrame } from "@/components/shell";
import { Dialog, StateBlock } from "@/components/ui";
import { getJson, postJson } from "@/lib/api";
import { describeError, type Message } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { can } from "@/lib/roles";

type AgentT = z.infer<typeof Agent>;
type SiteT = z.infer<typeof SiteList>["items"][number];
type Loaded = { agents: AgentT[]; sites: SiteT[] };
type State = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; data: Loaded };

const STATUS: Record<AgentT["status"], { label: string; glyph: "ya" | "tidak" | "belum-diuji" }> = {
  online: { label: "Terhubung", glyph: "ya" },
  offline: { label: "Tidak terhubung", glyph: "belum-diuji" },
  revoked: { label: "Dicabut", glyph: "tidak" },
};

function TokenDialog({ open, sites, onClose }: { open: boolean; sites: SiteT[]; onClose: () => void }) {
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  // The token lives in memory only, for as long as this dialog shows it.
  const [made, setMade] = useState<{ token: string; expiresAt: string } | null>(null);
  const chosen = sites.some((s) => s.id === siteId) ? siteId : (sites[0]?.id ?? "");

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson(`/v1/sites/${chosen}/enrollments`, {}, EnrollmentResponse);
      setMade({ token: r.token, expiresAt: r.expiresAt });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setMade(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title="Token pendaftaran agen">
      <div className="space-y-4 p-4">
        {error ? <StateBlock kind="error" title={error.title} hint={error.hint} /> : null}
        {made ? (
          <>
            <p className="text-muted">
              Berikan token ini ke teknisi lokasi. Token hanya ditampilkan sekali dan hanya bisa dipakai satu
              kali. Setelah dialog ditutup, token tidak bisa dilihat lagi.
            </p>
            <p className="mono break-all border border-line bg-panel p-3 text-lg" data-testid="enroll-token">
              {made.token}
            </p>
            <p>
              Berlaku sampai <time dateTime={made.expiresAt}>{formatDateTime(made.expiresAt)}</time>.
            </p>
            <p className="help">
              Di mini PC lokasi: <span className="mono">PANTAU_ENROLL_TOKEN=… pantau-agent enroll</span>
            </p>
            <button type="button" className="btn btn-primary" onClick={close}>
              Tutup
            </button>
          </>
        ) : (
          <>
            <p className="text-muted">
              Token berlaku 24 jam untuk satu agen di lokasi yang dipilih. Agen menyimpan kredensial kamera di
              mini PC lokasi, bukan di server.
            </p>
            <div>
              <label className="label" htmlFor="tok-lokasi">
                Lokasi
              </label>
              <select
                id="tok-lokasi"
                className="field"
                value={chosen}
                onChange={(e) => setSiteId(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void create()}
                disabled={busy || !chosen}
              >
                {busy ? "Membuat…" : "Buat token"}
              </button>
              <button type="button" className="btn btn-quiet" onClick={close}>
                Batal
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function RevokeDialog({
  agent,
  onClose,
  onDone,
}: {
  agent: AgentT | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const revoke = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/v1/agents/${agent.id}/revoke`, {}, Agent);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={agent !== null} onClose={onClose} title="Cabut agen?">
      <div className="space-y-4 p-4">
        {error ? <StateBlock kind="error" title={error.title} hint={error.hint} /> : null}
        <p>
          Agen <strong>{agent?.name}</strong> diputus sekarang dan tidak bisa tersambung lagi dengan token
          yang sama. Pemulihan berarti membuat token pendaftaran baru dan memasang ulang agen di lokasi.
        </p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn btn-primary" onClick={() => void revoke()} disabled={busy}>
            {busy ? "Mencabut…" : "Cabut agen"}
          </button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Batal
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function AgentCard({
  agent,
  site,
  canManage,
  onRevoke,
}: {
  agent: AgentT;
  site?: SiteT;
  canManage: boolean;
  onRevoke: () => void;
}) {
  const s = STATUS[agent.status];
  const ls = agent.lastStatus;
  return (
    <article aria-label={agent.name} className="border border-hair bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="h-section">{agent.name}</h2>
          <p className="mt-1 flex items-center gap-2 font-bold">
            <StateGlyph state={s.glyph} />
            <span>{s.label}</span>
          </p>
        </div>
        {canManage && agent.status !== "revoked" ? (
          <button type="button" className="btn" onClick={onRevoke} aria-label={`Cabut agen ${agent.name}`}>
            Cabut
          </button>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-bold">Lokasi</dt>
        <dd>{site?.name ?? agent.siteId}</dd>
        <dt className="font-bold">Versi</dt>
        <dd className="mono">{agent.version || "belum melapor"}</dd>
        <dt className="font-bold">Host</dt>
        <dd className="mono">{agent.hostname || "belum melapor"}</dd>
        <dt className="font-bold">Terakhir terlihat</dt>
        <dd>{agent.lastSeenAt ? formatDateTime(agent.lastSeenAt) : "belum pernah"}</dd>
        <dt className="font-bold">Kunci publik</dt>
        <dd className="mono">{agent.publicKeyFingerprint}</dd>
      </dl>
      {ls ? (
        <p className="mt-3 text-muted">
          Kamera terjangkau {ls.camerasOnline} dari {ls.camerasTotal} · CPU {Math.round(ls.cpuPercent)}% · RAM{" "}
          {Math.round(ls.memUsedPercent)}% · disk {Math.round(ls.diskUsedPercent)}%. Laporan terakhir pukul{" "}
          {formatDateTime(ls.at)}.
        </p>
      ) : (
        <p className="mt-3 text-muted">Belum ada laporan status dari agen ini.</p>
      )}
    </article>
  );
}

function AgenView() {
  const { role } = useSession();
  const manage = can.manageAgents(role);
  const [state, setState] = useState<State>({ status: "loading" });
  const [minting, setMinting] = useState(false);
  const [revoking, setRevoking] = useState<AgentT | null>(null);

  const load = useCallback(async () => {
    try {
      const [agents, sites] = await Promise.all([
        getJson("/v1/agents", AgentList),
        getJson("/v1/sites", SiteList),
      ]);
      setState({ status: "ready", data: { agents: agents.items, sites: sites.items } });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, []);
  useEffect(() => {
    if (can.viewAgents(role)) void load();
  }, [load, role]);

  if (!can.viewAgents(role)) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="h-page">Agen lokasi</h1>
        <div className="mt-4">
          <StateBlock
            kind="forbidden"
            title="Peran Anda tidak boleh melihat agen."
            hint="Minta pemilik atau NOC membukanya."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="h-page">Agen lokasi</h1>
      <p className="mt-1 text-muted">
        Agen berjalan di mini PC lokasi dan menyimpan kredensial kamera di sana. Server hanya menerima
        metadata perangkat dan status. Terhubung berarti agen sedang tersambung ke server ini; bukan jaminan
        kamera menyala.
      </p>
      {manage ? (
        <div className="mt-4">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setMinting(true)}
            disabled={state.status !== "ready" || state.data.sites.length === 0}
          >
            Buat token pendaftaran
          </button>
          {state.status === "ready" && state.data.sites.length === 0 ? (
            <p className="help">Buat lokasi dulu (tambahkan perangkat di halaman Perangkat).</p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-6">
        {state.status === "loading" ? (
          <StateBlock kind="loading" title="Memuat agen…" />
        ) : state.status === "error" ? (
          (() => {
            const m = describeError(state.error);
            return (
              <StateBlock
                kind="error"
                title={m.title}
                hint={m.hint}
                action={
                  <button type="button" className="btn" onClick={() => void load()}>
                    Coba lagi
                  </button>
                }
              />
            );
          })()
        ) : state.data.agents.length === 0 ? (
          <StateBlock
            kind="empty"
            title="Belum ada agen di organisasi ini."
            hint={
              manage
                ? "Buat token pendaftaran, lalu jalankan pantau-agent enroll di mini PC lokasi."
                : "Pemilik atau NOC membuat token pendaftaran untuk lokasi."
            }
          />
        ) : (
          <div className="space-y-4">
            {state.data.agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                site={state.data.sites.find((s) => s.id === a.siteId)}
                canManage={manage}
                onRevoke={() => setRevoking(a)}
              />
            ))}
          </div>
        )}
      </div>
      {state.status === "ready" ? (
        <TokenDialog
          open={minting}
          sites={state.data.sites}
          onClose={() => {
            setMinting(false);
            void load();
          }}
        />
      ) : null}
      <RevokeDialog
        agent={revoking}
        onClose={() => setRevoking(null)}
        onDone={() => {
          setRevoking(null);
          void load();
        }}
      />
    </div>
  );
}

export default function AgenPage() {
  return (
    <AppFrame>
      <AgenView />
    </AppFrame>
  );
}

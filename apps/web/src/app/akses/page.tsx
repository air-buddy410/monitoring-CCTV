"use client";

import { CameraList, DeviceList, Grant, GrantList, SiteList } from "@pantau/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useSession } from "@/components/session";
import { AppFrame } from "@/components/shell";
import { Dialog, StateBlock } from "@/components/ui";
import { effectiveAccess, type GrantT, LEVEL_LABEL } from "@/lib/access";
import { ApiError, getJson, postJson, postVoid } from "@/lib/api";
import { describeError, type Message } from "@/lib/errors";
import { can, ROLE_LABEL, toRole } from "@/lib/roles";

const Members = z
  .object({
    members: z.array(
      z
        .object({
          userId: z.string(),
          role: z.string(),
          user: z.object({ name: z.string().nullish(), email: z.string().nullish() }).passthrough().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface Person {
  userId: string;
  label: string;
  role: string;
}
interface Loaded {
  sites: z.infer<typeof SiteList>["items"];
  devices: z.infer<typeof DeviceList>["items"];
  cameras: z.infer<typeof CameraList>["items"];
  grants: GrantT[];
  people: Person[] | null;
}
type State = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; data: Loaded };

async function load(manager: boolean): Promise<Loaded> {
  const [sites, devices, cameras, grants] = await Promise.all([
    getJson("/v1/sites", SiteList),
    getJson("/v1/devices", DeviceList),
    getJson("/v1/cameras", CameraList),
    getJson("/v1/grants", GrantList),
  ]);
  let people: Person[] | null = null;
  if (manager) {
    // Member names come from Better Auth; noc may not be allowed to list them, so ids are the fallback.
    try {
      const m = await getJson("/api/auth/organization/list-members", Members);
      people = m.members.map((x) => ({
        userId: x.userId,
        role: x.role,
        label: x.user?.name || x.user?.email || x.userId,
      }));
    } catch {
      people = null;
    }
  }
  return { sites: sites.items, devices: devices.items, cameras: cameras.items, grants: grants.items, people };
}

const nameOf = (people: Person[] | null, id: string) => people?.find((p) => p.userId === id)?.label ?? id;

function GrantForm({ data, onDone, onCancel }: { data: Loaded; onDone: () => void; onCancel: () => void }) {
  const grantable = (data.people ?? []).filter((p) => p.role === "admin" || p.role === "member");
  const [userId, setUserId] = useState(grantable[0]?.userId ?? "");
  const [scope, setScope] = useState<"site" | "camera">("camera");
  const [scopeId, setScopeId] = useState("");
  const [permission, setPermission] = useState<"view" | "operate">("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const targets =
    scope === "site"
      ? data.sites.map((s) => ({ id: s.id, label: s.name }))
      : data.cameras.map((c) => {
          const dev = data.devices.find((d) => d.id === c.deviceId);
          return { id: c.id, label: `${c.name} (${dev?.name ?? "perangkat"})` };
        });
  const chosen = scopeId && targets.some((t) => t.id === scopeId) ? scopeId : (targets[0]?.id ?? "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !chosen) {
      setError({ title: "Pilih anggota dan target.", hint: "Keduanya wajib diisi." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson("/v1/grants", { userId, scope, scopeId: chosen, permission }, Grant);
      onDone();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 p-4" noValidate>
      {error ? <StateBlock kind="error" title={error.title} hint={error.hint} /> : null}
      <div>
        <label className="label" htmlFor="g-anggota">
          Anggota
        </label>
        <select id="g-anggota" className="field" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {grantable.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.label} ({ROLE_LABEL[toRole(p.role) ?? "viewer"]})
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="label">Berlaku untuk</legend>
        <div className="flex gap-4">
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="g-lingkup"
              checked={scope === "camera"}
              onChange={() => setScope("camera")}
              className="size-5"
            />
            Satu kamera
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="g-lingkup"
              checked={scope === "site"}
              onChange={() => setScope("site")}
              className="size-5"
            />
            Satu lokasi
          </label>
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor="g-target">
          {scope === "site" ? "Lokasi" : "Kamera"}
        </label>
        <select id="g-target" className="field" value={chosen} onChange={(e) => setScopeId(e.target.value)}>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="g-izin">
          Izin
        </label>
        <select
          id="g-izin"
          className="field"
          value={permission}
          onChange={(e) => setPermission(e.target.value as "view" | "operate")}
        >
          <option value="view">Lihat</option>
          <option value="operate">Operasi (snapshot, dan nanti PTZ dan putar ulang)</option>
        </select>
        <p className="help">
          Peran penonton tidak pernah bisa melakukan operasi, apa pun izin yang diberikan.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Menyimpan…" : "Beri akses"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Batal
        </button>
      </div>
    </form>
  );
}

function ManagerView({ data, reload }: { data: Loaded; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const canGrant = (data.people ?? []).some((p) => p.role === "admin" || p.role === "member");

  const revoke = async (g: GrantT) => {
    setError(null);
    try {
      await fetchDelete(`/v1/grants/${g.id}`);
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const bySite = data.sites.map((site) => {
    const devs = data.devices.filter((d) => d.siteId === site.id);
    const cams = data.cameras.filter((c) => c.siteId === site.id);
    return {
      site,
      devs,
      cams,
      siteGrants: data.grants.filter((g) => g.scope === "site" && g.scopeId === site.id),
    };
  });

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setAdding(true)}
          disabled={!canGrant || data.cameras.length === 0}
        >
          Beri akses
        </button>
        {data.people === null ? (
          <p className="text-muted">
            Daftar anggota tidak dapat dibaca dengan peran Anda, jadi akses baru belum bisa dibuat di sini.
          </p>
        ) : !canGrant ? (
          <p className="text-muted">
            Belum ada operator atau penonton di organisasi ini yang bisa diberi akses.
          </p>
        ) : null}
      </div>
      {error ? (
        <div className="mt-4">
          <StateBlock kind="error" title={error.title} hint={error.hint} />
        </div>
      ) : null}
      {bySite.length === 0 ? (
        <div className="mt-6">
          <StateBlock
            kind="empty"
            title="Belum ada lokasi."
            hint="Akses diberikan per lokasi atau per kamera. Tambahkan perangkat dulu di halaman Perangkat."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {bySite.map(({ site, cams, siteGrants }) => (
            <section key={site.id} aria-labelledby={`lok-${site.id}`}>
              <h2 id={`lok-${site.id}`} className="h-section">
                {site.name}
              </h2>
              <div className="mt-2 border border-hair bg-panel p-3">
                <p className="font-bold">Akses ke seluruh lokasi</p>
                {siteGrants.length === 0 ? (
                  <p className="text-muted">Tidak ada. Hanya pemilik yang menjangkau semua kamera di sini.</p>
                ) : (
                  <GrantRows
                    grants={siteGrants}
                    data={data}
                    where={`lokasi ${site.name}`}
                    onRevoke={revoke}
                  />
                )}
              </div>
              {cams.length === 0 ? (
                <p className="mt-2 text-muted">Lokasi ini belum punya kamera.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {cams.map((cam) => {
                    const own = data.grants.filter((g) => g.scope === "camera" && g.scopeId === cam.id);
                    return (
                      <li key={cam.id} className="border border-hair p-3">
                        <p className="font-bold">
                          {cam.name}{" "}
                          <span className="mono text-muted">
                            {data.devices.find((d) => d.id === cam.deviceId)?.name ?? cam.deviceId} · kanal{" "}
                            {cam.channel}
                          </span>
                        </p>
                        {own.length === 0 && siteGrants.length === 0 ? (
                          <p className="text-muted">Belum ada operator atau penonton yang diberi akses.</p>
                        ) : null}
                        {own.length > 0 ? (
                          <GrantRows
                            grants={own}
                            data={data}
                            where={`kamera ${cam.name}`}
                            onRevoke={revoke}
                          />
                        ) : null}
                        {siteGrants.length > 0 ? (
                          <p className="help">
                            Ditambah {siteGrants.length} akses dari lokasi (lihat di atas).
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
      <Dialog open={adding} onClose={() => setAdding(false)} title="Beri akses">
        {adding ? (
          <GrantForm
            data={data}
            onCancel={() => setAdding(false)}
            onDone={() => {
              setAdding(false);
              void reload();
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

async function fetchDelete(path: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { method: "DELETE", credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (res.ok) return;
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code;
  } catch {
    // body is not JSON
  }
  if (res.status === 401) window.location.assign(`/login?expired=1&next=${encodeURIComponent("/akses")}`);
  throw new ApiError(res.status, code);
}

function GrantRows({
  grants,
  data,
  where,
  onRevoke,
}: {
  grants: GrantT[];
  data: Loaded;
  where: string;
  onRevoke: (g: GrantT) => void;
}) {
  return (
    <ul className="mt-1 divide-y divide-[var(--line-soft)]">
      {grants.map((g) => {
        const who = nameOf(data.people, g.userId);
        return (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span>
              {who} <span className="text-muted">· {g.permission === "operate" ? "Operasi" : "Lihat"}</span>
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => onRevoke(g)}
              aria-label={`Cabut akses ${who} ke ${where}`}
            >
              Cabut
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MineView({ data }: { data: Loaded }) {
  const { role } = useSession();
  const rows = data.cameras.map((c) => ({ cam: c, level: effectiveAccess(role, c, data.grants) }));
  return (
    <div className="mt-4">
      <p className="text-muted">
        {role === "viewer"
          ? "Penonton hanya bisa melihat, dan hanya pada kamera yang diberi akses."
          : "Operator hanya mengoperasikan kamera yang diberi akses operasi."}{" "}
        Kamera tanpa akses tidak tampil sama sekali; server menolak permintaan ke kamera itu.
      </p>
      {rows.length === 0 ? (
        <div className="mt-4">
          <StateBlock kind="empty" title="Belum ada kamera yang diberi akses kepada Anda." />
        </div>
      ) : (
        <table className="mt-4 w-full border-t border-hair text-left">
          <caption className="sr-only">Akses Anda per kamera</caption>
          <thead>
            <tr className="border-b border-hair">
              <th scope="col" className="py-2 pr-4">
                Kamera
              </th>
              <th scope="col" className="py-2">
                Akses Anda
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cam, level }) => (
              <tr key={cam.id} className="border-b border-hair">
                <th scope="row" className="py-2 pr-4 font-bold">
                  {cam.name}
                </th>
                <td className="py-2">{LEVEL_LABEL[level]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AksesView() {
  const { role } = useSession();
  const manager = can.manageGrants(role);
  const [state, setState] = useState<State>({ status: "loading" });
  const reload = useCallback(async () => {
    try {
      setState({ status: "ready", data: await load(manager) });
    } catch (error) {
      setState({ status: "error", error });
    }
  }, [manager]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const body = useMemo(() => {
    if (state.status === "loading") return <StateBlock kind="loading" title="Memuat akses…" />;
    if (state.status === "error") {
      const m = describeError(state.error);
      return (
        <StateBlock
          kind="error"
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
    return manager ? <ManagerView data={state.data} reload={reload} /> : <MineView data={state.data} />;
  }, [state, manager, reload]);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="h-page">Akses kamera</h1>
      <p className="mt-1 text-muted">
        {manager
          ? "Pemilik menjangkau semua kamera. NOC mengelola akses tetapi tidak pernah melihat video. Operator dan penonton hanya menjangkau lokasi atau kamera yang diberikan di sini."
          : "Daftar kamera yang boleh Anda jangkau, menurut peran dan akses yang diberikan pemilik."}
      </p>
      {body}
    </div>
  );
}

export default function AksesPage() {
  return (
    <AppFrame>
      <AksesView />
    </AppFrame>
  );
}

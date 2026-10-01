"use client";

import { DeviceWithCameras, Site } from "@pantau/contracts";
import { type FormEvent, useState } from "react";
import { Dialog, StateBlock } from "@/components/ui";
import { postJson } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { describeError, type Message } from "@/lib/errors";
import { type DeviceFormValues, type FieldErrors, NEW_SITE, validateDeviceForm } from "@/lib/validate";
import type { SiteT } from "./data";

interface Preset {
  label: string;
  port: number;
}
const demo = process.env.NEXT_PUBLIC_DEMO === "1";
const PRESETS: Preset[] = (() => {
  if (!demo) return [];
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_DEMO_MOCKS ?? "[]") as Preset[];
  } catch {
    return [];
  }
})();

interface Props {
  open: boolean;
  onClose: () => void;
  sites: SiteT[];
  onCreated: (deviceId: string) => void;
}

const FIELD_FOR_CODE: Record<string, (keyof DeviceFormValues)[]> = {
  device_auth_failed: ["username", "password"],
  target_not_allowed: ["host"],
  device_timeout: ["host", "port"],
  device_unreachable: ["host", "port"],
  device_protocol_error: ["port"],
  site_not_found: ["siteId"],
};

export function AddDeviceDialog({ open, onClose, sites, onCreated }: Props) {
  const [v, setV] = useState<DeviceFormValues>({
    siteId: sites[0]?.id ?? NEW_SITE,
    newSiteName: "",
    name: "",
    host: "",
    port: "80",
    username: "",
    password: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DeviceFormValues>(k: K, val: DeviceFormValues[K]) => setV((p) => ({ ...p, [k]: val }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    const found = validateDeviceForm(v);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`dev-${first}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      let siteId = v.siteId;
      if (siteId === NEW_SITE) {
        const site = await postJson("/v1/sites", { name: v.newSiteName.trim() }, Site);
        siteId = site.id;
        // keep the created site selected so a retry does not create a second one
        setV((p) => ({ ...p, siteId: site.id }));
      }
      const created = await postJson(
        "/v1/devices",
        { siteId, name: v.name.trim(), host: v.host.trim(), port: Number(v.port), username: v.username, password: v.password },
        DeviceWithCameras,
      );
      onCreated(created.device.id);
    } catch (err) {
      setFailure(describeError(err));
      const code = err instanceof ApiError ? err.code : "";
      const marks: FieldErrors = {};
      for (const f of FIELD_FOR_CODE[code] ?? []) marks[f] = "Periksa isian ini.";
      setErrors(marks);
      setBusy(false);
    }
  };

  const field = (k: keyof DeviceFormValues) => ({
    id: `dev-${k}`,
    "aria-invalid": errors[k] ? (true as const) : undefined,
    "aria-describedby": errors[k] ? `dev-${k}-err` : undefined,
  });
  const err = (k: keyof DeviceFormValues) =>
    errors[k] ? (
      <p id={`dev-${k}-err`} className="error-text">
        {errors[k]}
      </p>
    ) : null;

  return (
    <Dialog open={open} onClose={onClose} title="Tambah perangkat">
      <form onSubmit={submit} noValidate className="space-y-4 overflow-y-auto p-4">
        {PRESETS.length > 0 ? (
          <div role="note" className="border border-hair bg-panel p-3">
            <p className="font-bold">Simulasi</p>
            <p className="text-muted">Isi dengan mock ONVIF lokal. Kredensialnya dummy.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.port}
                  className="btn"
                  onClick={() => setV((x) => ({ ...x, name: p.label, host: "127.0.0.1", port: String(p.port), username: "dummy-admin", password: "dummy-password" }))}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {failure ? <StateBlock kind="error" title={failure.title} hint={failure.hint} /> : null}
        {Object.keys(errors).length > 0 && !failure ? (
          <StateBlock kind="error" title="Isian belum lengkap." hint="Perbaiki kolom yang ditandai." />
        ) : null}

        <div>
          <label className="label" htmlFor="dev-siteId">
            Lokasi
          </label>
          <select {...field("siteId")} className="field" value={v.siteId} onChange={(e) => set("siteId", e.target.value)}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={NEW_SITE}>Buat lokasi baru</option>
          </select>
          {err("siteId")}
        </div>
        {v.siteId === NEW_SITE ? (
          <div>
            <label className="label" htmlFor="dev-newSiteName">
              Nama lokasi baru
            </label>
            <input {...field("newSiteName")} className="field" value={v.newSiteName} onChange={(e) => set("newSiteName", e.target.value)} />
            {err("newSiteName")}
          </div>
        ) : null}
        <div>
          <label className="label" htmlFor="dev-name">
            Nama perangkat
          </label>
          <input {...field("name")} className="field" value={v.name} onChange={(e) => set("name", e.target.value)} />
          {err("name")}
        </div>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <div>
            <label className="label" htmlFor="dev-host">
              Alamat IP
            </label>
            <input
              {...field("host")}
              className="field mono"
              inputMode="decimal"
              autoComplete="off"
              placeholder="192.168.1.20"
              value={v.host}
              onChange={(e) => set("host", e.target.value)}
            />
            {err("host")}
          </div>
          <div>
            <label className="label" htmlFor="dev-port">
              Port
            </label>
            <input {...field("port")} className="field mono" inputMode="numeric" value={v.port} onChange={(e) => set("port", e.target.value)} />
            {err("port")}
          </div>
        </div>
        <div className="grid gap-3 min-[520px]:grid-cols-2">
          <div>
            <label className="label" htmlFor="dev-username">
              Nama pengguna perangkat
            </label>
            <input {...field("username")} className="field" autoComplete="off" value={v.username} onChange={(e) => set("username", e.target.value)} />
            {err("username")}
          </div>
          <div>
            <label className="label" htmlFor="dev-password">
              Kata sandi perangkat
            </label>
            <input
              {...field("password")}
              type="password"
              className="field"
              autoComplete="off"
              value={v.password}
              onChange={(e) => set("password", e.target.value)}
            />
            {err("password")}
          </div>
        </div>
        <p className="help">
          Kredensial dipakai untuk probe ONVIF dan disimpan terenkripsi di server. Kredensial tidak ditampilkan lagi setelah ini.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
            {busy ? "Melakukan probe…" : "Tambah dan probe"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Batal
          </button>
        </div>
      </form>
    </Dialog>
  );
}

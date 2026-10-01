import { StateGlyph, type CapState } from "@/components/glyphs";
import { CAPABILITY_LABEL, CAPABILITY_ORDER, CAPABILITY_STATE, formatDateTime } from "@/lib/format";
import type { DeviceT, SiteT } from "./data";

const KIND: Record<string, string> = { nvr: "NVR (lebih dari satu kanal)", ipc: "Kamera tunggal" };

export function ProbeSheet({ device, site }: { device: DeviceT; site?: SiteT }) {
  const rows: [string, string, boolean?][] = [
    ["Merek", device.brand || "Tidak dilaporkan"],
    ["Model", device.model || "Tidak dilaporkan"],
    ["Firmware", device.firmware || "Tidak dilaporkan", true],
    ["Jenis", KIND[device.kind] ?? device.kind],
    ["Alamat", `${device.host}:${device.port}`, true],
    ["Lokasi", site?.name ?? device.siteId],
    ["Adapter", device.adapterId, true],
  ];
  return (
    <section aria-labelledby="probe-title" className="min-w-0">
      <h2 id="probe-title" className="h-section">
        Lembar probe
      </h2>
      <p className="mt-1 text-muted">
        Probe terakhir: <strong className="text-ink">{formatDateTime(device.createdAt)}</strong>, saat perangkat ditambahkan. Ini hasil
        probe pada saat itu, bukan status perangkat sekarang. Belum ada probe ulang di API.
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 border-t border-hair">
        {rows.map(([k, v, mono]) => (
          <div key={k} className="contents">
            <dt className="border-b border-hair py-2 font-bold">{k}</dt>
            <dd className={`border-b border-hair py-2 ${mono ? "mono" : ""}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-6 font-bold">Kemampuan</h3>
      <ul className="mt-2 border-t border-hair">
        {CAPABILITY_ORDER.map((key) => {
          const state = (device.capabilities[key] ?? "belum-diuji") as CapState;
          return (
            <li key={key} className="flex items-start gap-2 border-b border-hair py-2">
              <span className="mt-0.5">
                <StateGlyph state={state} />
              </span>
              <span className="min-w-0">
                <span className="block">{CAPABILITY_LABEL[key]}</span>
                <span className="block text-muted">{CAPABILITY_STATE[state] ?? state}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-muted">
        Kemampuan yang hanya diiklankan perangkat dicatat Belum diuji. PANTAU belum menyediakan video langsung, kendali PTZ, atau rekaman.
      </p>
    </section>
  );
}

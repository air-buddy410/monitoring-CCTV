const dateTime = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "medium" });
const clock = new Intl.DateTimeFormat("id-ID", { timeStyle: "medium" });

export const formatDateTime = (iso: string | Date) =>
  dateTime.format(typeof iso === "string" ? new Date(iso) : iso);
export const formatClock = (d: Date) => clock.format(d);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

export const CAPABILITY_LABEL: Record<string, string> = {
  live: "Alamat stream terbaca",
  snapshot: "Snapshot JPEG",
  ptz: "Konfigurasi PTZ terdeteksi",
  "ptz.preset": "Preset PTZ",
  "events.motion": "Event gerak",
  "playback.search": "Pencarian rekaman",
  "playback.stream": "Putar rekaman",
  health: "Kesehatan perangkat",
};
export const CAPABILITY_ORDER = Object.keys(CAPABILITY_LABEL);

export const CAPABILITY_STATE: Record<string, string> = {
  ya: "Terbukti saat probe",
  tidak: "Tidak tersedia",
  "belum-diuji": "Belum diuji",
};

export const AUDIT_LABEL: Record<string, string> = {
  "device.create": "Perangkat ditambahkan",
  "device.create.failed": "Penambahan perangkat gagal",
  "camera.snapshot": "Snapshot diambil",
  "camera.snapshot.failed": "Snapshot gagal",
  "site.create": "Lokasi dibuat",
  "site.update": "Lokasi diubah",
  "site.delete": "Lokasi dihapus",
  "camera.update": "Kamera diubah",
  "camera.snapshot.denied": "Snapshot ditolak (akses)",
  "camera.view.start": "Tontonan dimulai",
  "camera.view.stop": "Tontonan berhenti",
  "camera.ptz": "Perintah PTZ",
  "camera.playback.start": "Putar ulang dimulai",
  "camera.playback.stop": "Putar ulang berhenti",
  "grant.create": "Akses diberikan",
  "grant.delete": "Akses dicabut",
  "agent.enrollment.create": "Token pendaftaran agen dibuat",
  "agent.enroll": "Agen terdaftar",
  "agent.enroll.failed": "Pendaftaran agen gagal",
  "agent.revoke": "Agen dicabut",
  "agent.inventory.sync": "Inventaris agen disinkronkan",
};

export const REASON_LABEL: Record<string, string> = {
  rate_limited: "dibatasi laju permintaan",
  device_auth_failed: "kredensial ditolak perangkat",
  device_timeout: "perangkat tidak menjawab",
  device_unreachable: "perangkat tidak terjangkau",
  target_not_allowed: "alamat di luar kebijakan",
  device_protocol_error: "respons tidak dikenali",
  device_no_channels: "tidak ada kanal video",
  snapshot_invalid_image: "bukan JPEG yang sah",
  snapshot_uri_host_mismatch: "alamat snapshot di host lain",
  snapshot_uri_port_not_allowed: "port snapshot tidak diizinkan",
  snapshot_failed: "pengambilan gagal",
  no_grant: "tidak ada akses ke kamera ini",
  view_only: "akses hanya melihat, bukan operasi",
};

/** Only same-site relative paths may be used as a post-login destination. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/perangkat";
  return raw;
}

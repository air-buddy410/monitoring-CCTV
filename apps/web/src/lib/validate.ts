const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpLiteral(v: string): boolean {
  if (V4.test(v)) return true;
  // IPv6: let the URL parser decide, it rejects anything that is not a literal
  if (!v.includes(":")) return false;
  try {
    return new URL(`http://[${v}]/`).hostname !== "";
  } catch {
    return false;
  }
}

export interface DeviceFormValues {
  siteId: string;
  newSiteName: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
}
export type FieldErrors = Partial<Record<keyof DeviceFormValues, string>>;

export const NEW_SITE = "__new__";

export function validateDeviceForm(v: DeviceFormValues): FieldErrors {
  const e: FieldErrors = {};
  if (!v.siteId) e.siteId = "Pilih lokasi.";
  if (v.siteId === NEW_SITE && !v.newSiteName.trim()) e.newSiteName = "Isi nama lokasi baru.";
  if (!v.name.trim()) e.name = "Isi nama perangkat.";
  if (!v.host.trim()) e.host = "Isi alamat IP.";
  else if (!isIpLiteral(v.host.trim())) e.host = "Harus berupa alamat IP, misalnya 192.168.1.20. Nama host tidak dipakai.";
  const port = Number(v.port);
  if (!v.port.trim()) e.port = "Isi port.";
  else if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = "Port 1 sampai 65535.";
  if (!v.username) e.username = "Isi nama pengguna perangkat.";
  if (!v.password) e.password = "Isi kata sandi perangkat.";
  return e;
}

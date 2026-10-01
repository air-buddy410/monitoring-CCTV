import { ApiError } from "./api";

export interface Message {
  title: string;
  hint?: string;
}

const BY_CODE: Record<string, Message> = {
  unauthenticated: { title: "Sesi berakhir.", hint: "Masuk lagi untuk melanjutkan." },
  forbidden: {
    title: "Peran Anda tidak boleh melakukan ini.",
    hint: "Minta pemilik organisasi menaikkan peran Anda.",
  },
  no_active_organization: { title: "Belum ada organisasi aktif.", hint: "Pilih organisasi dulu." },
  not_a_member: { title: "Anda bukan anggota organisasi ini.", hint: "Pilih organisasi lain." },
  csrf_origin_rejected: {
    title: "Permintaan ditolak karena asalnya tidak tepercaya.",
    hint: "Buka PANTAU lewat alamat resminya, lalu coba lagi.",
  },
  rate_limited: { title: "Terlalu banyak percobaan." },
  validation_error: { title: "Isian belum valid.", hint: "Periksa kolom yang ditandai." },
  site_not_found: { title: "Lokasi tidak ditemukan.", hint: "Muat ulang daftar lalu pilih lokasi lagi." },
  device_not_found: { title: "Perangkat tidak ditemukan." },
  camera_not_found: { title: "Kamera tidak ditemukan.", hint: "Muat ulang daftar perangkat." },
  target_not_allowed: {
    title: "Alamat ini tidak boleh dipakai sebagai target.",
    hint: "Gunakan alamat IP privat perangkat (10.x, 172.16 sampai 172.31, 192.168.x). Alamat publik, link-local, dan loopback ditolak kebijakan server.",
  },
  device_auth_failed: {
    title: "Perangkat menolak nama pengguna atau kata sandi.",
    hint: "Periksa kredensial perangkat, lalu coba lagi.",
  },
  device_timeout: {
    title: "Perangkat tidak menjawab tepat waktu.",
    hint: "Periksa alamat, port, dan jaringan, lalu coba lagi.",
  },
  device_unreachable: { title: "Perangkat tidak dapat dijangkau.", hint: "Periksa alamat IP dan port." },
  device_protocol_error: {
    title: "Perangkat menjawab dengan cara yang tidak dikenali.",
    hint: "Pastikan port itu melayani ONVIF.",
  },
  device_no_channels: { title: "Perangkat tidak melaporkan kanal video." },
  snapshot_uri_host_mismatch: {
    title: "Perangkat menunjuk alamat snapshot di host lain. Ditolak demi keamanan.",
  },
  snapshot_uri_port_not_allowed: {
    title: "Perangkat menunjuk port snapshot yang tidak diizinkan. Ditolak demi keamanan.",
  },
  snapshot_invalid_image: { title: "Perangkat tidak mengirim gambar JPEG yang sah." },
  snapshot_not_jpeg: { title: "Respons bukan gambar JPEG, jadi tidak ditampilkan." },
  snapshot_channel_not_found: { title: "Kanal ini sudah tidak ada di perangkat." },
  snapshot_failed: { title: "Snapshot gagal diambil dari perangkat." },
  contract_mismatch: {
    title: "Respons server tidak sesuai kontrak API.",
    hint: "Versi web dan API mungkin tidak cocok.",
  },
  network_error: { title: "Server tidak dapat dihubungi.", hint: "Periksa koneksi, lalu coba lagi." },
  internal_error: { title: "Server mengalami galat.", hint: "Coba lagi sebentar lagi." },
  camera_not_granted: {
    title: "Anda belum diberi akses operasi ke kamera ini.",
    hint: "Minta pemilik memberi akses di halaman Akses.",
  },
  two_factor_required: {
    title: "Verifikasi dua langkah wajib untuk melihat video.",
    hint: "Aktifkan di halaman Keamanan, lalu coba lagi.",
  },
  grant_exists: {
    title: "Anggota ini sudah punya akses ke target itu.",
    hint: "Cabut dulu bila ingin mengubahnya.",
  },
  member_not_found: { title: "Anggota itu tidak ada di organisasi ini." },
  grant_not_found: { title: "Akses itu sudah tidak ada.", hint: "Muat ulang daftar akses." },
  INVALID_CODE: {
    title: "Kode salah.",
    hint: "Kode berganti tiap 30 detik. Masukkan kode yang sedang tampil.",
  },
  INVALID_BACKUP_CODE: { title: "Kode cadangan salah atau sudah dipakai." },
  INVALID_TWO_FACTOR_COOKIE: {
    title: "Verifikasi kedaluwarsa.",
    hint: "Masuk lagi dengan email dan kata sandi.",
  },
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: {
    title: "Terlalu banyak kode salah.",
    hint: "Masuk lagi dengan email dan kata sandi untuk memulai ulang.",
  },
  ACCOUNT_TEMPORARILY_LOCKED: {
    title: "Akun dikunci sementara karena terlalu banyak kode salah.",
    hint: "Coba lagi nanti.",
  },
  TOTP_ALREADY_ENABLED: { title: "Verifikasi dua langkah sudah aktif." },
  TWO_FACTOR_NOT_ENABLED: { title: "Verifikasi dua langkah belum aktif." },
  INVALID_PASSWORD: { title: "Kata sandi salah." },
  INVALID_EMAIL_OR_PASSWORD: { title: "Email atau kata sandi salah." },
  USER_ALREADY_EXISTS: { title: "Email ini sudah terdaftar.", hint: "Masuk dengan email itu." },
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: {
    title: "Email ini sudah terdaftar.",
    hint: "Masuk dengan email itu.",
  },
  PASSWORD_TOO_SHORT: { title: "Kata sandi terlalu pendek.", hint: "Minimal 12 karakter." },
  ORGANIZATION_ALREADY_EXISTS: { title: "Nama organisasi atau slug sudah dipakai." },
  ORGANIZATION_SLUG_ALREADY_TAKEN: { title: "Slug organisasi sudah dipakai." },
};

/** Turn any thrown value into copy for the operator. Never includes server text verbatim. */
export function describeError(err: unknown): Message {
  if (!(err instanceof ApiError))
    return { title: "Terjadi galat yang tidak dikenali.", hint: "Muat ulang halaman." };
  const known = BY_CODE[err.code];
  if (err.status === 429) {
    const wait = err.retryAfterSec ? ` Coba lagi dalam ${err.retryAfterSec} detik.` : " Tunggu sebentar.";
    return { title: "Terlalu banyak percobaan.", hint: `Server membatasi laju permintaan.${wait}` };
  }
  if (known) return known;
  if (err.status === 401) return BY_CODE.unauthenticated as Message;
  if (err.status === 403) return BY_CODE.forbidden as Message;
  if (err.status === 404) return { title: "Data tidak ditemukan." };
  if (err.status >= 500) return BY_CODE.internal_error as Message;
  return { title: "Permintaan gagal.", hint: `Status HTTP ${err.status}.` };
}

export const isForbidden = (err: unknown) => err instanceof ApiError && err.status === 403;
export const isRateLimited = (err: unknown) => err instanceof ApiError && err.status === 429;

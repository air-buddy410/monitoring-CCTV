# HASIL-CLOUD: PANTAU MVP-0

Tanggal eksekusi: 2026-10-01, container cloud Claude Code. Semua angka di bawah berasal dari eksekusi di sesi ini.

## 1. Model

`claude-sonnet-5-5`, diverifikasi lewat `get_session` (`session_context.model` = `configured_model` = `last_served_model` = `claude-sonnet-5-5`). Claude Code container 2.1.286.

## 2. Environment

| Komponen | Hasil pengecekan | Dampak |
|---|---|---|
| Node.js | v22.22.0 (PRD: 24 LTS) | Semua tes dijalankan di 22; Node 24 belum diuji |
| pnpm | 10.28.0 | OK |
| PostgreSQL | 16.14 terpasang tetapi mati; dinyalakan dengan `pg_ctlcluster 16 main start` (PRD: 17) | Semua tes RLS dijalankan di 16; PG 17 belum diuji |
| Docker | CLI 29.6.2 ada, **daemon tidak ada** (`/var/run/docker.sock` tidak ditemukan) | Tidak ada Docker Compose, tidak ada image/coturn/go2rtc; tidak diuji |
| Kamera/NVR fisik, jaringan lokasi | Tidak ada dan tidak diakses | Kompatibilitas perangkat nyata **tidak diuji** |
| Registry npm | Dapat diakses lewat proxy | Instalasi berhasil |

## 3. Fitur

### Selesai (terbukti oleh tes yang dijalankan)
- Monorepo pnpm: `apps/api`, `packages/{contracts,db,auth,onvif-client,adapters,mock-onvif}`.
- Autentikasi email+password dan organisasi (tenant) dengan Better Auth 1.7.7; peran owner/operator/viewer (D5).
- Tambah perangkat manual (`POST /v1/devices`) → probe ONVIF baca-saja (merek/model/firmware, kanal, kemampuan) → daftar kamera → snapshot JPEG (`POST /v1/cameras/:id/snapshot`).
- Isolasi tenant lewat PostgreSQL RLS (`FORCE`, role aplikasi non-superuser) dan 404 untuk tenant lain.
- Audit: `device.create`, `device.create.failed`, `camera.snapshot`, `camera.snapshot.failed` (aktor, target, IP, meta tanpa rahasia); `audit_log` append-only.
- Whitelist metode ONVIF di titik keluar transport, host pinning, deadline; perlindungan SSRF (D3).
- Kredensial perangkat terenkripsi AES-256-GCM, tidak muncul di respons/log/audit/dump DB.
- Mock ONVIF (SOAP + WS-Security digest + snapshot HTTP Digest).
- OpenAPI (`/docs/json`, `docs/openapi.json`).

### Belum dikerjakan (di luar lingkup atau sengaja ditunda)
Live video/go2rtc/WebRTC/TURN, WS-Discovery, agen WebSocket dan vault di agen, playback NVR, event gerak, PWA/web UI, 2FA, adapter Hikvision/Dahua, `camera_grant`, peran `noc`/support session, worker pg-boss, partisi audit/retensi, Docker Compose, CI, Turborepo. Rincian dan alasan: `docs/DECISIONS.md` D1, D8.

## 4. Perintah verifikasi dan hasil

Dijalankan setelah `rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/api/dist`.

| Perintah | Exit | Hasil |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | terpasang |
| `pnpm lint` | 0 | Biome: 63 berkas, tanpa temuan |
| `pnpm typecheck` | 0 | `tsc --noEmit` di semua paket |
| `pnpm test:unit` | 0 | 5 berkas, **57 tes lulus** |
| `pnpm test:integration` | 0 | 7 berkas, **47 tes lulus** (PostgreSQL 16 nyata + mock ONVIF) |
| `pnpm test` | 0 | unit 57 + integrasi 47 lulus (dijalankan dua kali, stabil) |
| `pnpm build` | 0 | API dibundel ke `apps/api/dist` |
| `pnpm openapi:export` | 0 | `docs/openapi.json` ditulis (9 path) |

Smoke test manual dari artefak build (`node apps/api/dist/server.js`) lewat HTTP nyata dengan `curl` melawan mock di 127.0.0.1: sign-in, buat org, buat site, tambah perangkat (brand `mockvendor`, 2 kamera, PTZ pada kamera 1), snapshot → HTTP 200 `image/jpeg`, 136 byte, `file` mengenalinya sebagai JPEG; `/v1/audit` memuat `device.create` dan `camera.snapshot`; `grep` log API untuk kata sandi perangkat dan kata sandi login: 0 kemunculan.

### Pemetaan ke syarat selesai
| Syarat | Bukti |
|---|---|
| Tenant A tambah mock, lihat kemampuan dan kamera, ambil snapshot JPEG | `device-flow.int.test.ts` (SOI `ffd8` dan EOI `ffd9` diperiksa) + smoke curl |
| Tenant B mendapat 404 untuk perangkat/kamera/snapshot A | `tenant-isolation.int.test.ts` (termasuk: mock tidak pernah dihubungi pada snapshot lintas tenant) |
| Isolasi di level DB | `rls.int.test.ts` (tanpa konteks → 0 baris, WITH CHECK, update/delete lintas tenant 0 baris, role non-bypass) |
| Kata sandi tidak bocor | `secrets.int.test.ts`: semua respons (sukses dan gagal), log level debug, `pg_dump` seluruh DB, kolom tabel, audit, skema respons OpenAPI |
| Metode di luar whitelist ditolak | `whitelist.unit.test.ts` (42 kasus) + `onvif-guard.int.test.ts` (SystemReboot, SetSystemDateAndTime, CreateUsers, DeleteUsers, StartFirmwareUpgrade, SetHostname, SOAP mentah; mock tidak pernah menerimanya) |
| OpenAPI | `openapi.int.test.ts` + `docs/openapi.json` |
| Audit penambahan perangkat dan snapshot | `audit.int.test.ts` |
| README | `README.md` |

### Pemeriksaan mutasi
Policy RLS tabel `device` sementara diganti `USING (true)`: 7 tes (RLS dan isolasi API) gagal sebagaimana mestinya; migrasi dipulihkan. Pemeriksaan ini manual dan tidak otomatis.

## 5. Perubahan pada tes setelah commit "merah"

Tes ditulis dan di-commit lebih dulu (`5f6da97`), lalu implementasi. Setelah itu tes diubah dua kali, tanpa melemahkan asersi:
1. `onvif-guard`: argumen `SetSystemDateAndTime` pada tes tidak valid sehingga pustaka menolak sebelum sampai ke guard. Input dibuat valid; asersi (`onvif_method_not_allowed`, mock tidak menerima) tetap.
2. `secrets`: pemeriksaan `"password"` pada `/docs/json` terlalu kasar karena dokumen memang menamai field *input*. Diganti: nilai sentinel tetap diperiksa pada dokumen itu, dan ditambah tes baru bahwa tidak ada skema **respons** yang memuat `password/username/credential`.
Selain itu Biome memformat ulang berkas tes (format saja). Dua percobaan perbaikan tidak terlampaui; tidak ada tes yang diulang >2 kali.

## 6. Kendala dan tes yang belum bisa dijalankan

- Tidak ada Docker: Compose, image agen, coturn, go2rtc tidak dibuat/diuji.
- Tidak ada kamera/NVR fisik: **keberhasilan dengan mock bukan bukti kompatibilitas kamera nyata.** Mock saya tulis sendiri berdasarkan struktur SOAP umum dan parser pustaka `onvif`; firmware nyata sering menyimpang (namespace, urutan elemen, GetServices vs GetCapabilities, autentikasi snapshot Basic/Digest, SOAP 1.1). Matriks kompatibilitas M0 belum ada.
- Node 22 dan PostgreSQL 16 saja; Node 24 dan PostgreSQL 17 (target PRD) belum diuji.
- Pemeriksaan `Origin`/CSRF Better Auth tidak tercakup tes otomatis (D11); dicek manual.
- Tidak ada uji beban, uji performa, pemindaian keamanan/dependensi (`npm audit`), maupun uji restore backup.
- `pnpm build` untuk paket library hanya typecheck (D8).
- Tidak ada CI; semuanya baru dijalankan lokal di container ini.

## 7. Risiko

1. **Kredensial di cloud (D1):** melanggar PRD A2 sampai agen dibuat; kunci vault satu proses dengan API.
2. **SSRF/pemindaian jaringan (D3):** user terautentikasi bisa membuat API menghubungi IP privat. Tanpa rate limit/allowlist per tenant.
3. **Pustaka `onvif` 1.0.0-rc.3 adalah release candidate** dan guard bergantung pada metode internal `rawRequest` (D4).
4. **Skema Drizzle dan SQL manual bisa menyimpang (D7)**; tabel Better Auth tak ber-RLS (D6).
5. **Kompatibilitas perangkat nyata belum diketahui** (lihat §6).
6. Probe sinkron di dalam request HTTP (maks beberapa kali timeout 5 dtk); belum ada antrean/rate limit.
7. Tidak ada rate limit login di mode test (Better Auth aktif di produksi saja); belum diuji.

## 8. Langkah berikutnya

1. M0 nyata: uji baca-saja di 1 Hikvision + 1 Dahua lab, simpan fixture SOAP tanpa kredensial, ganti/lengkapi mock, isi matriks kompatibilitas.
2. Pindahkan probe/snapshot dan vault kredensial ke agen (M2); hapus `device_secret`.
3. Tambah CI (lint/typecheck/test/build dengan PostgreSQL service), uji di Node 24 + PostgreSQL 17.
4. `camera_grant`, peran `noc`/support session, 2FA, rate limit probe, retensi/partisi audit.
5. Tes otomatis untuk Origin/CSRF; `npm audit` dan pengunci versi.

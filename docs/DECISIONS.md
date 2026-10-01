# Keputusan dan deviasi MVP-0

Format: konteks → keputusan → alasan/risiko. Hal yang ambigu di PRD v0.2 atau tidak bisa diikuti persis di environment ini.

## D1. Kredensial perangkat disimpan terenkripsi di cloud (deviasi sementara dari PRD A2)
- PRD A2/§11: kredensial hanya ada di agen. Agen (WS, vault lokal) **di luar lingkup MVP-0**, tetapi MVP-0 harus melakukan probe dan snapshot.
- Keputusan: API memegang kredensial hanya untuk probe/snapshot, disimpan di tabel terpisah `device_secret` sebagai blob AES-256-GCM (kunci `VAULT_KEY`, bukan di DB), tidak pernah ada di respons, log, audit, atau tabel `device`/`camera`. Dekripsi hanya di memori saat memanggil perangkat.
- Risiko: ini melanggar A2 sampai M2. Kunci ada di environment proses yang sama dengan DB client; pembobolan API = kredensial terbaca. **Harus dipindah ke agen di M2** dan tabel `device_secret` dihapus.

## D2. "Probe" dijalankan langsung dari API (pengganti agen)
Tidak ada agen/WebSocket, jadi API menghubungi perangkat sendiri lewat `packages/adapters`. Kontrak mengikuti PRD §7 (`probe`, `snapshot`), sehingga logikanya bisa dipindah ke agen tanpa ubah bentuk.

## D3. Perlindungan SSRF karena API menghubungi alamat dari pengguna
- Host harus **literal IP** (tanpa DNS, jadi tak ada DNS rebinding).
- Selalu ditolak: link-local (termasuk 169.254.169.254), unspecified, multicast/broadcast. Loopback ditolak kecuali `ALLOW_LOOPBACK_TARGETS=true` (dev/test untuk mock).
- Alamat privat RFC1918 **diizinkan** (kamera memang di LAN). Ini berarti API yang berada di jaringan internal dapat dipakai memindai jaringan itu oleh user terautentikasi. Mitigasi lanjutan (allowlist per tenant, rate limit probe) belum dibuat; di arsitektur final risiko ini hilang karena probe berjalan di agen.
- Alamat snapshot yang dikembalikan perangkat harus punya host sama dengan perangkat yang dituju (`snapshot_uri_host_mismatch`); redirect HTTP tidak diikuti; hanya Digest (Basic ditolak); maks 5 MB; wajib JPEG (SOI/EOI).

## D4. Whitelist ONVIF ditegakkan di satu titik keluar transport
Paket `onvif` 1.0.0-rc.3 punya satu jalur HTTP (`rawRequest`) yang dilewati semua metode (termasuk kiriman SOAP mentah). Wrapper menimpa jalur itu: nama operasi diambil dari isi SOAP Body (gagal = ditolak), dicocokkan dengan whitelist PRD §7 (`Get*`, `Find*`, `CreatePullPointSubscription`, `PullMessages`, `Unsubscribe`, `ContinuousMove`, `Stop`, `GotoPreset`), host dikunci ke perangkat yang dituju, dan ada deadline per request (`ONVIF_TIMEOUT_MS`, default 5 dtk, maks 10 dtk). Penimpaan memakai properti instans pada metode yang `private` di tipe pustaka; jika versi pustaka berganti nama metode itu, tes `onvif-guard` akan gagal. Versi dikunci persis (`1.0.0-rc.3`, PRD R2).
Catatan: `GetSystemDateAndTime` dan `GetServices`/`GetCapabilities` dipanggil oleh `connect()` pustaka; semuanya `Get*`.

## D5. Pembagian peran
Better Auth memakai `owner/admin/member`; PRD memakai `owner/operator/viewer`. Pemetaan: admin→operator, member→viewer. Tambah perangkat dan snapshot butuh operator+ (PRD F4 menaruh snapshot di operator; PRD tidak menyebut siapa boleh menambah perangkat, dipilih operator+), audit hanya owner (PRD §9.1). Peran `noc` dan `camera_grant` belum ada.
Tenant diambil dari `activeOrganizationId` pada sesi sisi-server dan **keanggotaan dicek ulang tiap request**; `organization_id` di body ditolak (skema `strict`).

## D6. RLS
Aplikasi terhubung sebagai role `pantau_app` (bukan superuser, tanpa BYPASSRLS, bukan pemilik tabel). Tabel tenant (`site`, `device`, `device_secret`, `camera`, `audit_log`) `ENABLE` + `FORCE ROW LEVEL SECURITY`; policy memakai `current_setting('app.org_id', true)` yang diisi `set_config(..., true)` (lokal-transaksi) di `withTenant()`. Tanpa konteks → nol baris. `audit_log` hanya `SELECT/INSERT` untuk aplikasi, plus trigger statement-level yang menolak UPDATE/DELETE bahkan untuk pemilik tabel. Tabel Better Auth (`user`, `session`, `organization`, `member`, ...) **tidak** ber-RLS karena dikelola Better Auth; isolasinya dijaga kode (keanggotaan dicek per request).
Kunci komposit `(site_id, organization_id)` dll. mencegah baris anak menunjuk induk milik tenant lain.

## D7. Migrasi SQL tulisan tangan + skema Drizzle terpisah
PRD menyebut drizzle-kit. Policy RLS, trigger, dan grant lebih jelas dan teruji sebagai SQL maju-saja (`packages/db/migrations`, runner kecil dengan `schema_migrations` dan advisory lock). Skema Drizzle di `packages/db/src/schema.ts` dipakai untuk query bertipe dan **harus disinkronkan manual** dengan SQL (risiko drift; tes integrasi akan gagal bila kolom tak cocok). Tabel Better Auth ditulis tangan sesuai skema Better Auth 1.7.7 dengan nama kolom snake_case.

## D8. Hal dari PRD yang sengaja tidak dikerjakan di MVP-0
- Tidak ada web UI (Next.js), worker/pg-boss, Turborepo, partisi bulanan `audit_log`, retensi, `agent`, `camera_grant`, `view_layout`, `event`, 2FA, `/v1/grants`, `/v1/agents`, dll. Monorepo memakai pnpm workspaces saja (`pnpm -r`); Turborepo baru bermanfaat saat paket lebih banyak.
- Paket `libs` diekspor sebagai sumber TypeScript (tanpa langkah build sendiri); API dibundel dengan tsup. `pnpm build` untuk paket library hanya typecheck.
- Docker Compose tidak dibuat: tidak ada daemon Docker di environment ini sehingga tidak bisa diuji; tidak dikirim berkas yang belum diuji.
- CI GitHub Actions belum dibuat.

## D9. Versi runtime
PRD: Node 24 LTS dan PostgreSQL 17. Environment: Node 22.22.0 dan PostgreSQL 16.14 (terpasang, tidak bisa diganti tanpa jaringan/Docker). Kode memakai fitur yang ada di keduanya; `engines` = `>=22`. Belum diuji di Node 24/PostgreSQL 17.

## D10. Pemetaan kamera dan kemampuan
- Satu *video source* ONVIF = satu `camera`. Profil dengan resolusi terbesar = main, terkecil = sub. `kind` = `nvr` bila >1 kanal, selain itu `ipc` (heuristik; tidak ada cara pasti lewat ONVIF dasar).
- Kemampuan hanya `ya` bila dibuktikan oleh panggilan nyata saat probe (`live`: GetStreamUri sukses; `snapshot`: GetSnapshotUri sukses, **URI-nya belum diambil saat probe**; `ptz`: ada konfigurasi PTZ pada profil atau layanan PTZ). `ptz.preset`, `health`, serta event/playback yang diiklankan perangkat dicatat `belum-diuji`; yang tidak diiklankan `tidak`. URI RTSP tidak disimpan (bisa memuat kredensial).
- `brand` dinormalisasi dari `Manufacturer` (hikvision/dahua/axis, selain itu huruf kecil tanpa simbol). `adapter_id` selalu `onvif-generic` di MVP-0.

## D11. Perilaku yang tidak tercakup tes otomatis
Tes dijalankan dengan `NODE_ENV=test`, dan Better Auth melewati pemeriksaan `Origin` (CSRF) pada mode itu. Pemeriksaan itu terbukti aktif saat dijalankan manual dengan `curl` tanpa header `Origin` (403 `MISSING_OR_NULL_ORIGIN`), tetapi tidak ada tes otomatisnya.

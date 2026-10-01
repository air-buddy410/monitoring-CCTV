# HASIL-GELOMBANG2: PANTAU M1 selesai, M2 dimulai

Gelombang 2 dari PRD v0.2 (bagian 12). Semua pekerjaan memakai data dummy dan simulator berlabel Simulasi. **Tidak ada kamera fisik, jaringan produksi, atau layanan berbayar yang disentuh. Kamera fisik dan live CCTV tetap BELUM TERVERIFIKASI.** Ini bukan klaim aplikasi siap produksi, dan tidak ada PR yang di-merge.

## 1. Cabang, PR, dan status

| Cabang | PR | Isi | Status CI |
|---|---|---|---|
| `claude/pantau-web-mvp1` | [#2](https://github.com/air-buddy410/monitoring-CCTV/pull/2) (draft) | MVP-1 dan perbaikan Rex (R-1) | hijau untuk `a4611f4` (verify dan e2e) |
| `claude/pantau-w2-m1` | [#3](https://github.com/air-buddy410/monitoring-CCTV/pull/3) (draft, basis `claude/pantau-web-mvp1`) | M1: 2FA, grant, CRUD, katalog audit, readiness | hijau untuk `77449c0` (verify dan e2e, 2 run) |
| `claude/pantau-w2-m2-agent` | PR #4 (draft, basis `claude/pantau-w2-m1`) | M2 awal: agen, pendaftaran, protokol WS, halaman Agen | lihat bagian 8 |

Tes ditulis lebih dulu dan terbukti merah sebelum kodenya untuk: CRUD site dan kamera, grant, 2FA, readiness, katalog audit (51 gagal), kontrak agen, pendaftaran dan agen (15 gagal), WebSocket agen (tidak ada rute, tes menggantung), dan 5 berkas unit agen. Pengecualian jujur, yang ditulis sebelum kodenya tetapi **tidak dijalankan merah** terlebih dulu: `agent-e2e.int.test.ts`, `agents.e2e.ts` (halaman Agen), tes E2E 2FA dan grant, dan tes layar M1; `env.unit.test.ts` ditulis bersama kodenya. Untuk pemindaian kebocoran, merahnya dibuktikan dengan mutasi (bagian 4).

## 2. Gerbang (instalasi bersih, `pnpm install --frozen-lockfile`)

| Perintah | Node 24.21.0 + PostgreSQL 17.10 | Node 22.22.0 + PostgreSQL 16.14 |
|---|---|---|
| `pnpm lint` | exit 0 | exit 0 |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test:unit` | exit 0, **225 lulus** (23 berkas) | exit 0, **225 lulus** |
| `pnpm test:integration` | exit 0, **224 lulus** (20 berkas) | exit 0, **224 lulus** |
| `pnpm build` | exit 0 (API, web, agen) | exit 0 |
| `pnpm test:e2e` | exit 0, **69 lulus** (Chromium, Playwright 1.56.1) | exit 0, **69 lulus** |

Sebelum gelombang ini (HEAD `a4611f4`): unit 135, integrasi 112, E2E 39. Tambahan: unit +90, integrasi +112, E2E +30. Kekhawatiran stabilitas: tes baru dijalankan berulang (agen WS 3 kali, klien agen 5 kali, e2e agen 3 kali, integrasi penuh 4 kali, tata letak M1 3 kali) tanpa kegagalan setelah perbaikan di bagian 6.

## 3. Item per item

| # | Permintaan | Hasil | Bukti |
|---|---|---|---|
| 1 | 2FA TOTP dan kode cadangan, UI pendaftaran dan verifikasi login, E2E | Selesai | `two-factor.int.test.ts` (14), `two-factor.e2e.ts` (4), halaman Keamanan, langkah kode di layar masuk |
| 2 | `/v1/grants` GET/POST/DELETE, skema, RLS, peran, UI akses per kamera, isolasi tenant | Selesai | `grants.int.test.ts` (20), `grants.e2e.ts` (5), halaman Akses |
| 3 | PATCH/DELETE `/v1/sites/:id`, PATCH `/v1/cameras/:id` | Selesai (juga `GET /v1/sites/:id`) | `sites-cameras-crud.int.test.ts` (12) |
| 4 | Aksi audit tontonan dan perintah | Selesai sebagai katalog dan pintu tunggal | `audit-actions.int.test.ts` (5), `audit-catalogue.unit.test.ts` (2); belum ada endpoint live, PTZ, playback yang memakainya |
| 5 | `/healthz` dan `/readyz` (DB, nanti pg-boss) | Selesai; titik pasang pg-boss siap, pg-boss belum ada | `health.int.test.ts` (6) |
| 6 | `apps/agent`: WS dengan `Authorization: Agent`, hello, inventory.sync, status 30 dtk, backoff 1 sampai 60 dtk dengan jitter, heartbeat 20 dtk, batas waktu per permintaan | Selesai untuk lingkup ini | 66 tes unit di `apps/agent/test`, `agent-e2e.int.test.ts` (9) |
| 7 | Skema Zod pesan agen (amplop `{id,type,ts,payload}`) dan endpoint agen | Selesai | `packages/contracts/src/agent.ts`, `agent.unit.test.ts` (11) |
| 8 | `POST /v1/sites/:id/enrollments`, `GET /v1/agents`, `GET /v1/agents/:id`, `POST /v1/agents/:id/revoke`; token disimpan sebagai hash | Selesai (ditambah `POST /v1/agent/enroll`, D25) | `agent-enrollment.int.test.ts` (22), `agent-ws.int.test.ts` (24), `agents.e2e.ts` (3) |
| 9 | Vault kredensial di agen, bukan di DB cloud untuk jalur agen | Selesai | `vault.unit.test.ts` (11), `devices.unit.test.ts` (10), pemindaian sentinel di `agent-e2e` |
| 10 | Tes: agen mendaftar (mock), inventory sync, status, kredensial TIDAK ada di DB, log, pesan WS; token salah ditolak | Selesai | lihat bagian 4 |

## 4. Bukti kredensial tidak bocor (item 10)

`agent-e2e.int.test.ts` menjalankan agen sungguhan (kode `apps/agent`) terhadap API sungguhan dan simulator ONVIF berlabel Simulasi dengan kata sandi sentinel `Dummy-Sentinel-Pw-7391!`. Sebuah relay WebSocket perekam berada di antara agen dan API, jadi yang dipindai adalah isi kabel, bukan tiruan. Setelah agen mendaftar, menambah perangkat, menyinkronkan, dan melaporkan status (kamera berubah online lalu offline saat simulator dimatikan), yang dipindai untuk sentinel kata sandi dan nama pengguna adalah:

- semua baris semua tabel `public` (`x::text`), tanpa pengecualian;
- log API dan log agen;
- setiap bingkai WebSocket dua arah (jenis yang dikirim agen hanya `hello`, `inventory.sync`, `status`);
- semua berkas di direktori data agen, termasuk `vault.json` dan `vault.key` (kata sandi tidak ada dalam bentuk polos, tetapi agen sendiri masih dapat membukanya);
- keluaran baris perintah `enroll`, `add-device`, dan `run`, serta token (pendaftaran dan agen) di semua tempat itu.

Tabel `device_secret` kosong untuk perangkat dari agen. Dua pemeriksaan tambahan di tingkat kontrak dan server: skema bingkai `strict` (tidak ada kolom kredensial) dan pemindaian kunci terlarang di kedalaman berapa pun, sehingga `password`, `username`, `rtspUri`, `snapshotUri`, `token` ditolak (`forbidden_field`) dan tidak ditulis.

**Pemindaian terbukti bisa merah**: dengan satu baris sementara yang mencetak kata sandi ke log agen, tes gagal dengan `agent logs contains the device password`; dengan kata sandi disisipkan ke inventaris, server menolak bingkai (jadi tes gagal lebih awal). Kedua perubahan sementara dikembalikan; `git diff` kosong.

Negatif yang diuji: token agen salah (jabat tangan 401, agen melapor `unauthorized`, tepat satu percobaan, tidak ada agen baru), agen dicabut saat terhubung (penutupan 4401, tidak kembali), token pendaftaran dipakai ulang, kedaluwarsa, salah skema, tertukar dengan token agen, dan enam pendaftaran serempak (tepat satu menang).

## 5. Temuan dan perbaikan di jalan

1. **Tombol primer, frame 1,04:1 (tema gelap)** saat berganti dari nonaktif ke aktif: latar masih memudar dari gelap sementara teks sudah berganti seketika. Ditemukan audit kontras baru, dikunci tes per frame (`states.e2e.ts`) yang terbukti gagal pada kode lama (3,99 terang, 1,04 gelap). Perbaikan: latar tombol primer tidak dianimasikan.
2. **Bilah atas meluap di 768 px** setelah tautan Agen ditambahkan: audit tata letak menangkapnya; bilah kini membungkus baris. Tidak ada ambang yang dilonggarkan.
3. **Target sentuh kotak centang** diukur dari kotak label (yang memang disentuh), bukan kotak 20 px.
4. **`fileParallelism: false` di proyek Vitest tidak berlaku** (16 pasang berkas berjalan serempak pada satu DB). Dipindah ke akar; 0 tumpang tindih; integrasi tetap sekitar 1 menit. Satu tes agen yang menghitung seluruh tabel jadi gagal 2 dari 3 run sebelum ini ketahuan; asersinya kini per tenant.
5. **Bundel agen**: `onvif` dan `undici` perlu menjadi dependensi langsung agen agar tidak ikut terbundel (galat `Dynamic require`); `node dist/main.js` kini berjalan.
6. Sesi lama menjadi tidak sah setelah konfirmasi 2FA (Better Auth membuat sesi baru); tes yang menyiapkan keadaan lewat API disusun ulang urutannya, dan balapan `Set-Cookie` terlambat saat berganti pengguna di satu konteks browser ditutup dengan `networkidle`.

## 6. Deviasi dan hal yang belum

Lengkap di `docs/DECISIONS.md` D20 sampai D30. Yang paling penting:

- **Tidak ada `noc` lintas tenant** dan tidak ada sesi dukungan; `noc` hanya berlaku dalam satu organisasi dan tidak pernah melihat video (D20).
- **Grant default tolak untuk video** dan hanya snapshot yang kini memakainya; daftar kamera tidak dipersempit (D21). Dua tes lama diberi grant di penyiapan (asersi tidak berubah).
- **2FA wajib untuk video** hanya lewat `REQUIRE_2FA_FOR_VIDEO` (bawaan nyala di production); kejadian 2FA belum masuk audit (D22).
- **pg-boss belum ada**; hanya titik pasang readiness (D24).
- **Dari M2 belum dikerjakan**: WS-Discovery, UI lokal onboarding `:8080`, go2rtc, instalator, image Docker, snapshot lewat agen. Kehadiran agen hanya benar untuk satu proses API (D25).
- Jalur langsung D1 (kredensial terenkripsi di cloud) tetap ada sebagai jembatan.
- Kunci publik agen disimpan tetapi belum dipakai menandatangani apa pun.

## 7. Pertanyaan terbuka

1. **Vitest 3 ke 4** untuk menutup 2 temuan moderate (GHSA-82fw-gwwq-j7x9, hanya `better-auth/dist/test-utils`, bukan runtime): **belum dilakukan, menunggu jawaban Budi.** Mengubah pelari seluruh tes, termasuk tes backend.
2. Bila `noc` harus lintas tenant: bentuk RLS-nya (peran basis data khusus, atau tenant `perumnet-noc` dengan kebijakan baca lintas organisasi terbatas) perlu diputuskan sebelum M6.
3. Audit untuk kejadian 2FA (tingkat pengguna, tanpa organisasi): apakah perlu tabel audit akun terpisah.
4. Apakah daftar perangkat dan kamera juga harus dipersempit oleh grant, atau cukup aksi video (D21).

## 8. CI

Lihat PR masing-masing untuk run terbaru. Run untuk commit terbaru cabang ini dicatat di deskripsi PR #4 sesudah push.

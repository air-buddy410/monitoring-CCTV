# HASIL-FRONTEND: PANTAU MVP-1 (frontend web)

Tanggal: 2026-10-01. Semua angka berasal dari eksekusi di sesi cloud ini. Dokumen ini bukan audit independen (audit independen oleh Rex belum dilakukan dan tidak diklaim) dan bukan pernyataan siap produksi. Kamera fisik, live CCTV, playback, PTZ, dan produksi tidak diverifikasi.

## 1. Model, HEAD, status

- Model: `claude-sonnet-5-5`, diverifikasi lewat `get_session` (`configured_model` = `last_served_model` = `claude-sonnet-5-5`). Tidak ada pergantian model, paid usage, top-up, atau auto-reload.
- Kuota: pada pengecekan terakhir `rate_limit_info` sesi menunjukkan `seven_day` berstatus `rejected` tanpa overage, namun sesi tetap berjalan dan bekerja sampai selesai. Tidak ada upaya melewati banner limit. Bila sesi terputus, itu blocker kuota.
- HEAD awal: `d0ba7056f087a9fdb7a95e0649d35599ce26ce91` (`claude/pantau-hardening`, CI success, tidak ada commit baru di remote, working tree bersih).
- Branch kerja: `claude/pantau-web-mvp1` (dibuat dari HEAD tersebut). PR bertumpuk [#2](https://github.com/air-buddy410/monitoring-CCTV/pull/2) (basis `claude/pantau-hardening`, draft, tidak di-merge). PR #1 tidak di-merge.
- Commit kode terakhir sebelum berkas ini: `29d34b1ea970d3bc8eb703e0354e44b8dbbdca3e`. HEAD akhir adalah commit yang memuat berkas ini (lihat PR #2).

## 2. Skill yang dibaca (dari salinan pemilik)

Diekstrak dari `PANTAU-SKILLS-ASLI.md` ke `~/.claude/skills/` (hanya di sesi cloud; tidak disalin ke repo karena lisensi redistribusi belum diperiksa). Ketujuh berkas cocok dengan bytes dan SHA256 manifest, diverifikasi ulang dengan `sha256sum`. Seluruh isi keenam skill dibaca.

| Path | SHA256 (12 awal) |
|---|---|
| `~/.claude/skills/antislop/SKILL.md` | 86f73b9947f7 |
| `~/.claude/skills/antislop-ui/SKILL.md` | 47d989277125 |
| `~/.claude/skills/antislop-copywriting/SKILL.md` | 2434a6fb0603 |
| `~/.claude/skills/antislop-layoutmobile/SKILL.md` | 8613395a5109 |
| `~/.claude/skills/antislop-human/SKILL.md` | 5bc7c8e56cc7 |
| `~/.claude/skills/antislop-human/contrast-check.py` | 619cdf3da8b2 |
| `~/.claude/skills/antislop-code/SKILL.md` | 004933009d35 |

Taste skill dan skill dashboard khusus tidak ada dan tidak dijadikan gerbang (sesuai instruksi). Wizard instalasi antislop dilewati dan mode "selama pengerjaan" dipakai atas instruksi pemilik. `contrast-check.py` dijalankan (`--selftest`: 8 pasangan OK) untuk semua pasangan warna UI.

## 3. Sumber dokumentasi

- Context7: **tidak tersedia** di tool sesi ini, dan tidak diklaim.
- Situs resmi `nextjs.org` dan `better-auth.com` diblokir proxy egress (`EGRESS_BLOCKED`) saat WebFetch dicoba.
- Yang dipakai: dokumentasi resmi Next.js 16.3.8 yang ikut di dalam paket npm (`node_modules/next/dist/docs/.../rewrites.md`, rewrite ke URL eksternal), kode dan tipe Better Auth 1.7.7 terpasang (daftar endpoint organization, `get-active-member-role`, perilaku `skipOriginCheck`), tipe dan README paket Playwright 1.56.1, serta README `onvif`. Keterbatasan: tidak ada pengecekan terhadap dokumentasi terbaru di web.

## 4. Perintah dan hasil

Dijalankan dari instalasi bersih (`rm -rf node_modules .next dist` lalu `pnpm install --frozen-lockfile`).

| Perintah | Node 24.21.0 + PostgreSQL 17.10 | Node 22.22.0 + PostgreSQL 16.14 |
|---|---|---|
| `pnpm install --frozen-lockfile` | exit 0 | exit 0 |
| `pnpm lint` | exit 0 | exit 0 |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test:unit` | exit 0, **135 lulus** (12 berkas) | exit 0, **135 lulus** |
| `pnpm test:integration` | exit 0, **112 lulus** (12 berkas) | exit 0, **112 lulus** |
| `pnpm build` | exit 0 (API dan web) | exit 0 |
| `pnpm test:e2e` | exit 0, **30 lulus** (Chromium r1194, Playwright 1.56.1) | exit 0, **30 lulus** (lihat 4.2) |

PG17 lokal adalah biner komunitas dari paket npm `@embedded-postgres/linux-x64` (17.10, port 5433). PG17 resmi (`postgres:17`, 17.11) diuji di CI GitHub (lihat bagian 9).

Rincian jumlah: unit 135 = backend 66 (tidak berubah) + web 69. Integrasi 112 (tidak berubah dari HEAD awal, gerbang backend utuh). E2E 30 (baru): flow 3, access 6, errors 6, layout 12 (5 lebar x 2 tema + tema + reduced motion), controls 3.

### 4.1 Baseline backend (Tahap preflight)
Pada HEAD awal di Node 24 + PG17: lint, typecheck, build exit 0, unit 66, integrasi 112, CI success. Tidak ada blocker keamanan, tidak ada tes backend yang diubah atau dilemahkan.

### 4.2 Ketidakstabilan yang ditemukan dan akar masalahnya
Pada satu run di Node 22, satu tes E2E gagal dan lulus di run berikutnya. Tidak ditutup dengan "flake": run diulang sampai kegagalan tertangkap (tes `papan ketik: layar masuk ...`, indikator fokus). Akar masalah: halaman masuk memakai `useSearchParams` di dalam `Suspense` dengan fallback kosong, sehingga HTML dari server tidak memuat formulir sampai hidrasi; tes menekan Tab sebelum formulir ada, fokus jatuh ke `body`. Perbaikan produk: formulir dirender server (`apps/web/src/app/login/page.tsx` membaca address bar setelah mount). Perbaikan tes: menunggu kolom Email terlihat. Setelah itu E2E diulang berturut-turut di Node 22: 29/29 dikali 5 run bersih (suite saat itu 29 tes), lalu 30/30 di Node 24 dan 30/30 di Node 22 setelah 1 tes ditambahkan. Dua run lain gagal karena dua proses E2E milik saya berjalan bersamaan (port 3100 terpakai, database `pantau_e2e` dibuang oleh run lain); itu kesalahan operasi, bukan cacat produk.

## 5. Temuan dari verifikasi dan perbaikannya (path berkas)

Cacat produk yang ditangkap tes atau inspeksi screenshot, lalu diperbaiki:

| # | Temuan | Perbaikan |
|---|---|---|
| 1 | Teks `StateBlock` mewarisi warna viewer (terang) pada panel terang: kontras 1.15 di tema terang (audit kontras runtime) | `components/ui.tsx`: `text-ink` |
| 2 | Bilah aksi ponsel membungkus dua baris dan menutup konten terakhir | `snapshot-stage.tsx` (grid 2 kolom), `workspace.tsx` (`pb-44`) |
| 3 | Dialog native tidak menjebak fokus secara siklik | `ui.tsx`: `cycleFocus` |
| 4 | Fokus tidak kembali ke pemicu setelah tombol X (dialog di-remount lewat `key`) | `add-device-dialog.tsx` dipecah (form hanya ada saat terbuka), `ui.tsx` menyimpan pemicu |
| 5 | Login baru tanpa organisasi aktif selalu dilempar ke pemilih | `session.tsx`: organisasi tunggal diaktifkan otomatis |
| 6 | Dialog menempel di pojok kiri atas (preflight Tailwind mereset `margin`) | `globals.css`: `margin: auto` (asersi posisi tengah ditambahkan; terbukti gagal tanpa perbaikan, selisih 36 px) |
| 7 | Kelas komponen tak berlapis mengalahkan utilitas (tombol Menu muncul di desktop, margin judul hilang) | `globals.css`: `@layer base` dan `@layer components` |
| 8 | Pesan galat fallback menggemakan string kode dari server | `lib/errors.ts`: hanya status HTTP numerik (tes unit merah dulu) |
| 9 | Pilihan perangkat di daftar hanya dibedakan warna | `device-rail.tsx`: penanda teks "(dipilih)" |
| 10 | Nama aksesibel tautan kamera diawali placeholder visual | `camera-slots.tsx`: placeholder `aria-hidden`, info pindah ke keterangan |
| 11 | Halaman masuk kosong sampai hidrasi | lihat 4.2 |

Koreksi atas tes saya sendiri (bukan pelemahan): tes sesi-berakhir awalnya lulus palsu karena URL sempat cocok sebelum redirect (kini menunggu keadaan akhir `Lembar probe`); pemeriksaan "tidak ada kata sandi di DOM" salah menghitung kolom yang masih terbuka (kini dialog ditutup dulu, yang sekaligus membuktikan nilai dibuang); tes timeout memakai kata sandi salah yang tersisa dari langkah sebelumnya. Tidak ada tes dihapus, di-skip, atau dilonggarkan, dan tes backend tidak diubah.

## 6. Matriks kontrol (R-26, R-35)

"E2E" = Playwright terhadap API dan PostgreSQL nyata (`apps/web/e2e`). "Demo" = dijalankan pada stack `pnpm demo` oleh skrip screenshot (manual, bukan CI).

| Kontrol | Hasil | Bukti |
|---|---|---|
| Masuk (email, sandi) | berhasil; sandi salah ditolak dengan pesan dan kolom sandi dikosongkan | E2E access |
| Daftar / Sudah punya akun? Masuk / Buat akun dan masuk | bekerja dua arah | E2E flow, access |
| Isi akun simulasi (demo saja) | mengisi akun dummy | Demo |
| Pilih organisasi, Gunakan {nama}, Buat organisasi | data berganti menurut organisasi | E2E flow, controls |
| Organisasi tunggal aktif otomatis | ya | E2E access |
| Keluar (bilah atas, menu ponsel, halaman organisasi) | sesi berakhir (401 sesudahnya) | E2E flow, controls |
| Logo PANTAU, Perangkat, Audit, Ganti organisasi | berpindah halaman | E2E flow, controls |
| Menu (ponsel): buka, Escape, fokus kembali, tautan, tema, keluar | bekerja | E2E controls |
| Mode gelap | berganti, bertahan setelah muat ulang, warna sesuai token | E2E layout, controls |
| Cari, Lokasi, Jenis, Kemampuan, Saring (ponsel), Lihat N, Hapus saringan | bekerja; hasil kosong menampilkan keadaan sendiri | E2E flow, controls |
| Tautan perangkat, tautan kamera, Kembali ke daftar | bekerja, penanda "(dipilih)" | E2E flow, controls |
| Tambah perangkat (kepala daftar dan keadaan kosong) | membuka dialog | E2E flow, controls |
| Dialog tambah: validasi, fokus ke kolom salah, Tambah dan probe, Batal, Tutup (X), Escape, jebakan fokus, fokus kembali | bekerja; sandi dibuang saat ditutup | E2E flow, errors, controls |
| Preset Simulasi (demo saja) | mengisi alamat, port, kredensial dummy | Demo |
| Ambil snapshot / lagi (klik, Enter, Space) | setiap tekan menjangkau mock (hitungan permintaan) | E2E flow, controls |
| Layar penuh, Tutup layar penuh, Escape | bekerja; fokus kembali | E2E flow, controls |
| Unduh JPEG | berkas `.jpg` terunduh | E2E controls |
| Audit: daftar, jumlah catatan, Coba lagi | bekerja untuk pemilik | E2E flow, controls |
| Coba lagi (daftar), Muat ulang (sesi gagal) | memulihkan | E2E errors, controls |
| Viewer: tidak ada Tambah, Ambil snapshot, Audit; paksa endpoint | UI menyembunyikan, server 403 | E2E access |
| Operator: tambah dan snapshot ya, audit tidak | sesuai matriks backend | E2E access |
| Tenant B: daftar kosong, `?d=` milik A, API 404 | tidak melihat data A | E2E access |
| Sesi berakhir (sesi dihapus di DB) | `/login?expired=1&next=...`, lalu kembali ke halaman semula | E2E access |
| 429 probe dan snapshot (nyata dari backend) | pesan dengan detik, tombol terkunci dengan hitung mundur | E2E errors |
| Snapshot gagal (bukan JPEG, setelah sempat berhasil) | keadaan galat, tidak ada gambar, pulih setelah mock dipulihkan | E2E errors |
| Perangkat menolak kredensial, alamat di luar kebijakan, timeout | pesan khusus tiap kasus | E2E errors |
| Jaringan terputus (diputus di sisi browser) | pesan dan pemulihan | E2E errors |

Tidak ada kontrol dekoratif: kontrol yang tidak didukung API tidak ditampilkan (lihat D18).

## 7. Keamanan dan privasi

- Cookie sesi httpOnly dan tak terbaca script (E2E). Tidak ada token atau kata sandi di localStorage, sessionStorage, URL, atau konsol; hanya kunci `pantau-theme` di localStorage (E2E `noLeaks` dan tes unit higiene).
- Kata sandi perangkat tidak ada di HTML halaman setelah dialog ditutup dan tidak pernah di URL permintaan (E2E).
- Origin/CSRF backend tidak dinonaktifkan; browser berbicara ke satu origin lewat rewrite Next.js.
- Hanya kredensial dummy di repo. Tidak ada secrets, tidak ada konfigurasi produksi.
- Rate limit 429 diuji terhadap backend nyata (batas E2E sengaja kecil).

## 8. Kontras, tema, responsif

Skrip antislop-human (`contrast-check.py`) dijalankan untuk 16 pasangan per tema; 0 gagal. Rasio terendah: teks 6.26 (aksen sebagai teks, terang) dan 7.30 (muted di atas raised, gelap), batas kontrol/non-teks 3.23 (terang) dan 3.56 (gelap), lawan batas 3.0. Contoh: teks/bg 15.43 (terang) dan 15.85 (gelap); on-accent/accent 9.70. Tes unit menghitung ulang dari `tokens.css` asli. Tes E2E juga menghitung kontras teks nyata di halaman (semua simpul teks terlihat) pada lebar 360, 390, 768, 1024, 1440 px di tema terang dan gelap, bersama pemeriksaan overflow horizontal, kontrol di luar viewport, target sentuh 44 px, konten tidak tertutup bilah aksi, dan konsol bersih. Reduced motion: tanpa animasi dan transisi (E2E).

## 9. CI

`.github/workflows/ci.yml`: job `verify` (tidak diubah) dan job baru `e2e` (Node 24, `postgres:17`, install Chromium, build web, `pnpm test:e2e`). Tanpa `continue-on-error`, `permissions: contents: read`.

Hasil untuk commit kode `29d34b1` (diverifikasi dari API GitHub dan log job):

- Push: https://github.com/air-buddy410/monitoring-CCTV/actions/runs/36828925359 , job `verify` success (semua langkah) dan job `e2e` success (install Chromium, build web, Browser E2E).
- Pull request: https://github.com/air-buddy410/monitoring-CCTV/actions/runs/36828929378 , success.
- Log job `e2e` (PostgreSQL 17.11 resmi, Node 24): `30 passed (41.4s)`.
- Run untuk commit-commit sebelumnya pada branch yang sama juga success (runs 36826626675, 36827355511, 36828603600, 36828622340).
- Commit dokumentasi terakhir (hanya berkas Markdown dan catatan) memicu run sendiri; hasilnya tampil di PR #2 dan tidak dikutip di sini.

Catatan: peringatan GitHub tentang action v4 di Node 20 yang dipaksa ke Node 24 masih ada; action belum dipin ke SHA.

## 10. Audit antislop (Delivery Gate, bukti)

Tiap baris dijalankan terhadap UI yang berjalan. PASS hanya bila ada bukti.

**Design Read:** dashboard operasional multi-tenant untuk NOC dan admin lokasi, bahasa visual meja inspeksi, dial ENERGY 2 / RHYTHM 2 / MOTION 1 (`DESIGN.md`).

| Blok dan aturan | Status | Bukti |
|---|---|---|
| R-02 tanpa em dash | PASS | pemindaian seluruh berkas baru (tes unit untuk src, skrip untuk docs); 0 hit |
| R-03 mobile | PASS | E2E lebar 360, 390, 768: tanpa overflow, kontrol tidak terpotong, bilah aksi tidak menutup konten |
| R-17, R-18, R-36, R-38 tanpa angka, kesaksian, klaim palsu | PASS | angka di UI hanya hitungan nyata (jumlah perangkat, kamera, byte, waktu); label Simulasi di banner dan dalam gambar; "disimpan terenkripsi" benar (AES-GCM, D1) |
| R-23 aset | PASS | wordmark teks, tanpa logo, avatar, foto orang; fixture gambar buatan sendiri, provenance dicatat |
| R-24 navigasi | PASS | semua tautan punya tujuan nyata (E2E); Audit hanya untuk pemilik |
| R-25 kontras | PASS | skrip antislop 0 gagal; E2E hitung nyata di 10 kombinasi lebar x tema |
| R-26, C-2 kontrol berfungsi | PASS | matriks bagian 6 |
| R-27 status | PASS | memuat, kosong, galat, dilarang, sesi berakhir, hasil saring kosong (E2E); tiap status menyebut sebab dan langkah berikutnya |
| R-28 FAQ | PASS | tidak ada |
| R-32 papan ketik | PASS | urutan Tab, jebakan fokus siklik, Escape, fokus kembali, indikator fokus ada |
| R-33 tanpa patch skrip | PASS | fitur ditulis di sumber; `make-demo-frames.mjs` menghasilkan gambar, bukan menambal sumber |
| R-34 kedua tema | PASS | seluruh audit layout dan kontras dijalankan di terang dan gelap, tombol tema diuji |
| R-35 verifikasi | PASS | aplikasi dibangun dan dijalankan; klik-lewat per kontrol di bagian 6; konsol bersih di setiap tes |
| R-37 arah | PASS | `DESIGN.md` dengan dial dan Design Read sebelum membangun |
| R-01, R-07, R-10, R-13 gradien, grid latar, kaca, glow | PASS | tidak dipakai (tes unit memeriksa blur dan backdrop) |
| R-04 ikon | PASS | enam glif gambar sendiri ditambah tiga penanda status (sudut runcing), kegunaan di `glyphs.tsx` dan DESIGN.md; tanpa ikon AI generik |
| R-06 tipografi | PASS | Atkinson Hyperlegible dengan alasan tertulis; mono hanya data teknis |
| R-08, R-09 panah, lencana | PASS | tidak ada panah dekoratif, tidak ada lencana kapsul, tidak ada titik status berdenyut |
| R-12 bayangan | PASS | hanya dialog (elevasi, alasan tertulis) |
| R-14, R-05 bukan kartu seragam, bukan template | PASS | bukan sidebar plus kartu statistik; fokus pada snapshot; tiga keadaan tata letak berbeda |
| R-19 animasi | PASS | hanya fade dialog 100 ms dan perubahan warna tombol; dimatikan saat reduced motion |
| R-22 ilustrasi | PASS | tidak ada; fixture adalah gambar dari kamera simulasi |
| R-11 radius | PASS | 6 px kontrol, 10 px dialog, bingkai media persegi; tidak ada kapsul |
| R-15, R-16 CTA, buzzword | PASS | CTA spesifik ("Tambah dan probe", "Ambil snapshot"); tes unit memeriksa daftar buzzword |
| R-20, R-30 identitas, bukan klon | PASS (penilaian) | motif tanda potong dan lembar probe; bukan bahasa visual produk lain. Ini penilaian saya, bukan uji objektif |
| R-21 tema | PASS | alasan tertulis; kedua tema berfungsi |
| R-29 palet | PASS | dua keluarga netral plus satu aksen amber; merah dan hijau hanya penanda status disertai teks dan ikon |
| R-31 alasan satu baris | PASS | tabel catatan keputusan di `DESIGN.md` |
| Liveliness (titik fokus, aksen, motif, whitespace) | PASS (penilaian) | snapshot sebagai fokus; aksen untuk aksi utama dan pilihan; motif tanda potong |
| antislop-copywriting | PASS | Bahasa Indonesia, tanpa buzzword, tanpa em dash, aktor jelas, status menyebut sebab; satu daftar tiga butir ("video langsung, kendali PTZ, atau rekaman") adalah fakta nyata, bukan irama |
| antislop-code | PASS | komentar satu baris yang menjelaskan alasan |
| antislop-human | PASS | kontras, fokus, status tidak hanya warna (glif dan teks), keadaan terpersepsi |
| antislop-layoutmobile | PASS | tiga keadaan lebar, tanpa overflow, target 44 px, bilah aksi dengan ruang aman |

Batas audit: item bertanda "penilaian" bersifat subjektif. Zoom 200% hanya didekati lewat lebar 360 px (tidak ada uji zoom browser). Keyboard layar ponsel yang menutup kolom isian tidak diuji pada perangkat nyata.

## 11. Screenshot (UI nyata dari stack demo, tanpa rahasia)

Di `docs/screenshots/`, diambil oleh `apps/web/scripts/screenshots.ts` dari `pnpm demo`:
`desktop-gelap-masuk.png`, `desktop-gelap-perangkat-kosong.png`, `desktop-gelap-tambah-perangkat.png`, `desktop-gelap-snapshot.png`, `desktop-gelap-audit.png`, `desktop-terang-snapshot.png`, `ponsel-terang-masuk.png`, `ponsel-terang-snapshot.png`, `ponsel-gelap-snapshot.png`. Hanya data dummy dan gambar fixture bertuliskan SIMULASI. Ini bukti inspeksi visual (saya melihat gambar sebelum dipakai), terpisah dari tes API dan E2E.

## 12. Perubahan tes dan alasannya

Baru: `apps/web/test/*.unit.test.ts` (69 tes) dan `apps/web/e2e/*.e2e.ts` (30 tes). Tes backend tidak diubah. Satu penyesuaian tidak langsung: `packages/mock-onvif` mendapat opsi tambahan (`port`, `snapshotFrames`, `setSnapshotBody`, `loadDemoFrames`) yang tidak mengubah perilaku bawaan; 112 tes integrasi tetap lulus tanpa perubahan.

## 13. Belum terverifikasi atau BLOCKED

- Kamera fisik, kompatibilitas firmware nyata, live video, playback, PTZ, event, push, PWA, produksi, uji beban: tidak diverifikasi.
- Browser selain Chromium (Firefox, Safari, iOS), perangkat sentuh nyata, keyboard layar ponsel, pembaca layar nyata: tidak diuji. Aksesibilitas diperiksa lewat tes otomatis dan inspeksi, bukan uji dengan pengguna.
- Mode demo (banner, preset, akun simulasi) diverifikasi lewat skrip screenshot pada stack demo, bukan di CI.
- Daftar dimuat penuh tanpa paginasi (API belum mendukung); perilaku dengan ratusan perangkat tidak diuji.
- Pendaftaran akun terbuka di backend dan tampil di UI; pembatasannya adalah keputusan backend (lihat docs/DEMO.md).
- Panggilan `get-active-member-role` dan `organization/list` mengandalkan perilaku Better Auth 1.7.7 yang dibaca dari kode terpasang, bukan dari dokumentasi daring.
- Action GitHub masih dipin ke tag, bukan SHA.
- Audit independen oleh Rex: belum dilakukan.

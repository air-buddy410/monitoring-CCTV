# Demo lokal "Simulasi" dan cara menjalankan frontend

Semua yang tampil di mode demo berasal dari backend nyata yang berbicara dengan **mock ONVIF** lokal. Tidak ada kamera nyata, tidak ada jaringan luar, dan semua kredensial adalah dummy.

## Kebutuhan

- Node.js 24 (juga diuji di 22) dan pnpm 10 (`corepack enable`).
- PostgreSQL 16 atau 17 yang sedang berjalan di mesin yang sama, dengan akses superuser lokal. Bawaan: `postgresql://postgres:postgres@127.0.0.1:5432/postgres`. Ubah lewat `PANTAU_TEST_ADMIN_URL`. Untuk menyiapkan role dan sandi dummy di instalasi sistem: `pnpm db:setup` (lihat README).

## Menjalankan demo

```bash
pnpm install --frozen-lockfile
pnpm demo
```

`pnpm demo` melakukan, berurutan: membuat database `pantau_demo` baru (role non-superuser dan migrasi RLS), menyalakan dua mock ONVIF (`127.0.0.1:4101` NVR 2 kanal dengan PTZ di kanal 1, `127.0.0.1:4102` kamera tunggal), menyalakan API di `:3101`, mendaftarkan satu akun dummy dan organisasi "Lab Simulasi", membangun aplikasi web dengan `NEXT_PUBLIC_DEMO=1`, lalu menjalankannya di **http://localhost:3100**. Berhenti dengan Ctrl+C.

Akun dummy (hanya untuk lab): `demo@pantau.test` / `Dummy-Demo-Pass-123`. Layar masuk punya tombol "Isi akun simulasi".

Alur yang bisa dicoba: masuk, pilih organisasi (jika diminta), Tambah perangkat, pilih tombol "Simulasi NVR 2 kanal" (mengisi alamat, port, dan kredensial dummy), Tambah dan probe, lihat Lembar probe, Ambil snapshot, Ambil snapshot lagi, Layar penuh, pindah kamera, Audit.

Pembeda mode demo: banner kuning "Mode Simulasi" di semua layar, tombol isi-otomatis di dialog tambah perangkat, dan tulisan SIMULASI di dalam setiap gambar. Mode normal tidak memuat satu pun dari itu, dan kode demo hanya aktif bila `NEXT_PUBLIC_DEMO=1` saat build.

## Mode normal (tanpa fixture)

1. Jalankan API dengan `BASE_URL` sama dengan alamat publik web, misalnya `BASE_URL=http://localhost:3100`. Lihat `.env.example` untuk variabel lain, termasuk `TARGET_ALLOW_CIDRS`. Jangan menyalakan `ALLOW_LOOPBACK_TARGETS` di luar lab.
2. Bangun web dengan alamat API: `PANTAU_API_ORIGIN=http://127.0.0.1:3101 pnpm --filter @pantau/web build`. Nilainya ikut terpanggang saat build karena dipakai oleh rewrite Next.js.
3. Jalankan: `pnpm --filter @pantau/web start` (port 3100).

Browser hanya berbicara dengan origin web. Next.js meneruskan `/api/auth/*` dan `/v1/*` ke API, sehingga cookie sesi, pemeriksaan Origin, dan CSRF backend berlaku tanpa dilonggarkan.

Catatan keamanan: pendaftaran akun (`POST /api/auth/sign-up/email`) terbuka di backend dan antarmuka web menampilkan tombol Daftar. Untuk penggunaan di luar lab, batasi pendaftaran di backend lebih dulu.

## Tes browser (E2E)

```bash
pnpm --filter @pantau/web exec playwright install chromium   # sekali saja
pnpm --filter @pantau/web build
pnpm test:e2e
```

`test:e2e` membuat database `pantau_e2e` baru, lalu Playwright menyalakan API dan `next start`. Tes membuat mock ONVIF sendiri di port acak. Batas laju di E2E sengaja kecil (6 per menit untuk probe dan snapshot) agar respons 429 yang diuji berasal dari backend sungguhan.

## Screenshot

Dengan `pnpm demo` berjalan di terminal lain: `pnpm --filter @pantau/web demo:screenshots`. Hasilnya ditulis ke `docs/screenshots/`.

## Provenance fixture gambar

`packages/mock-onvif/fixtures/frame-{1,2,3}.jpg` dibuat oleh `apps/web/scripts/make-demo-frames.mjs` (adegan abstrak gambar sendiri yang dirender Chromium, tanpa orang dan tanpa aset pihak ketiga). Tiap gambar bertuliskan SIMULASI dan "FIXTURE LAB, BUKAN CCTV NYATA". Dibuat khusus untuk repo ini, tanpa lisensi pihak ketiga.

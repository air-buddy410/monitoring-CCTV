# HASIL-GELOMBANG3: sisa M2 (agen)

Semua pekerjaan memakai data dummy dan simulator berlabel Simulasi. **Tidak ada kamera fisik, jaringan produksi, akun Hik-Connect, atau layanan berbayar yang disentuh. Kamera fisik, live CCTV, dan jaringan LAN nyata tetap BELUM TERVERIFIKASI.** Ini bukan klaim PRD 100% dan bukan klaim siap produksi.

## 1. Keadaan kode (tepatnya)

- Basis: `e45e70e656c9eae6da831c758ac3f0cce71a7f13` (`claude/pantau-w2-m2-agent`).
- Cabang kerja lokal: `claude/pantau-w3-m2-rest`. **Tidak ada commit dan tidak ada push**: izin eksplisit untuk gelombang ini belum ada. Seluruh pekerjaan adalah perubahan working tree yang belum di-commit (HEAD = basis, dirty): 31 berkas diubah (557 tambah, 128 hapus, belum termasuk berkas baru) dan 17 berkas atau direktori baru (`git status`: 48 entri). Karena tidak ada commit, kerja ini hanya ada di sesi ini dan hilang bila wadahnya diambil kembali.
- Tidak ada PR yang dibuka, ditutup, atau digabung. PR #4 tidak disentuh.

Berkas baru: `apps/agent/src/{discovery,go2rtc,local-ui,local-ui-page,snapshot-handler}.ts`, lima berkas tes agen, `apps/api/test/{wire.ts,integration/agent-snapshot.int.test.ts,integration/inventory-grants.int.test.ts}`, `apps/web/e2e/agent-local.e2e.ts`, `packages/mock-onvif/src/discovery.ts`, `deploy/agent/*`.

## 2. Gerbang

Node 22.22.0 dengan PostgreSQL 16 (satu-satunya kombinasi di lingkungan ini). **Node 24 dengan PostgreSQL 17 belum dijalankan** di gelombang ini; CI proyek memakainya, jadi itu yang harus dilihat setelah ada push.

| Perintah | Hasil |
|---|---|
| `pnpm lint` | exit 0 (188 berkas) |
| `pnpm typecheck` | exit 0 |
| `pnpm test:unit` | exit 0, **301 lulus** (28 berkas); sebelumnya 225 |
| `pnpm test:integration` | exit 0, **251 lulus** (22 berkas); sebelumnya 226 |
| `pnpm build` | exit 0 (API, web, agen) |
| `pnpm test:e2e` | exit 0, **73 lulus** (Chromium); sebelumnya 69 |

Tes baru ditulis lebih dulu dan terbukti merah (modul tidak ada atau mutasi) sebelum kodenya: grant inventaris, snapshot agen, WS-Discovery, go2rtc, onboarding lokal. Mutasi yang dicoba: pendengar go2rtc diubah ke `0.0.0.0` membuat tes config merah. Pengecualian jujur: `agent-local.e2e.ts` dan `deploy.unit.test.ts` ditulis bersama kodenya, tidak dijalankan merah dulu. Tes discovery, snapshot agen, dan go2rtc dijalankan 3 kali berturut-turut tanpa kegagalan; integrasi penuh dan E2E penuh dijalankan sekali pada keadaan akhir.

## 3. Acceptance M2 (PRD bagian 12: "agen mendaftar, menemukan kamera lab, metadata muncul di web; kredensial tidak ada di DB/log/pesan WS")

| Butir | Status | Bukti |
|---|---|---|
| Pendaftaran, WS reconnect, inventory sync, status | Lulus (gelombang 2) | lihat HASIL-GELOMBANG2 |
| Discovery | Lulus **hanya terhadap responder Simulasi** | `discovery.unit.test.ts` (15) |
| UI lokal onboarding | Lulus terhadap mock ONVIF | `local-ui.unit.test.ts` (24), `agent-local.e2e.ts` (4: 360 dan 1280 px, terang dan gelap, kontras dan target sentuh dihitung) |
| Vault kredensial | Lulus | sandi tidak ada di berkas JSON, respons, URL, localStorage, konsol browser |
| Snapshot lewat agen | Lulus terhadap mock | `agent-snapshot.int.test.ts` (13), `snapshot-handler.unit.test.ts` (6) |
| Kredensial tidak ada di DB/log/pesan WS | Lulus | pemindaian sentinel `Dummy-Sentinel-Pw-7391!` pada DB, log, bingkai, berkas |
| Grant pada semua akses perangkat dan kamera tenant | Lulus | `inventory-grants.int.test.ts` (12); RLS noc tidak dilonggarkan |
| go2rtc terikat loopback | Lulus untuk generator config dan klien | `go2rtc.unit.test.ts` (19); **supervisor proses belum ada**, biner asli belum diuji |
| Image dan installer agen | **Hanya statis** | `deploy.unit.test.ts` (7); image tidak dibangun, `install.sh` tidak dijalankan di host nyata |
| "Menemukan kamera lab" di mini PC | **Tertunda** | tidak ada mini PC dan tidak ada kamera nyata |

## 4. Gap yang tersisa (jangan dibaca sebagai selesai)

1. Bukti lapangan: tidak ada kamera nyata. WS-Discovery belum pernah menerima jawaban dari perangkat sungguhan; perilaku multicast di switch, VLAN, dan antarmuka ganda belum diketahui.
2. Docker: tidak ada daemon, image tidak pernah dibangun; digest dasar belum dipin. systemd: unit tidak dimuat di host.
3. go2rtc: tanpa supervisor, tanpa biner asli, tanpa alur live ke penonton. Hanya aturan loopback dan klien yang terbukti.
4. Onboarding lokal berjalan di `http` biasa; bind LAN mengirim PIN dan sandi tanpa TLS (D35).
5. Kehadiran agen masih satu proses API (D25).
6. Node 24 dan PostgreSQL 17 belum dijalankan untuk keadaan ini.
7. Hik-Connect: rencana yang belum dibuktikan. Tidak ada kode, akun, atau API vendor.
8. Vitest 3 ke 4 tidak dilakukan (menunggu jawaban Budi).

## 5. Pertanyaan untuk Budi

1. Izin commit dan push untuk `claude/pantau-w3-m2-rest` (cabang baru dari `e45e70e`, dibuka sebagai PR draft)? Tanpa itu kerja ini tidak tersimpan di luar sesi.
2. PR #4 (Rex) dan PR #5 bentrok: mana yang dipertahankan?
3. Bolehkah bind onboarding lokal ke IP LAN dipakai di produksi, atau wajib lewat TLS atau terowongan lebih dulu?
4. Vitest 3 ke 4: setuju atau tidak?

Status: NEEDS_INPUT (izin commit dan push). Bukan izin merge atau deploy.

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
- **Diperbarui (putaran lanjutan, D12):** kebijakan sekarang berupa allow-list eksplisit; lihat D12. Risiko yang tersisa: API di jaringan internal tetap dapat dipakai memindai rentang privat yang diizinkan oleh user terautentikasi (dibatasi rate limit, belum ada allow-list per tenant); di arsitektur final risiko ini hilang karena probe berjalan di agen.
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

## D11. (DIGANTI oleh D13) Pemeriksaan Origin tidak tercakup tes
Putaran pertama mencatat bahwa Better Auth melewati pemeriksaan Origin saat `NODE_ENV=test`. Sudah diperbaiki dan diuji di D13.

## D12. Kebijakan target perangkat eksplisit (putaran lanjutan)
Urutan keputusan di `apps/api/src/target-policy.ts`: (1) selalu ditolak: 0.0.0.0/8, link-local 169.254/16 dan fe80::/10, multicast, broadcast, metadata cloud (AWS IPv6 `fd00:ec2::254`, Alibaba `100.100.100.200`, Azure `168.63.129.16`), `::`; (2) loopback hanya dengan `ALLOW_LOOPBACK_TARGETS=true` (pengecualian lab/dev); (3) allow-list: bawaan = RFC1918 + `fc00::/7` (IP privat tetap didukung untuk kamera lab); alamat publik **ditolak** secara bawaan. `TARGET_ALLOW_CIDRS` mengganti (bukan menambah) daftar bawaan, tetapi tidak pernah mengalahkan daftar (1). IPv4-mapped IPv6 di-unwrap sebelum dicek; ejaan IP non-kanonik (`0177.0.0.1`, `2130706433`, `127.1`) bukan literal IP dan ditolak.
Alamat snapshot dari perangkat: host harus sama dengan perangkat, skema http/https, port hanya 80/443/port ONVIF yang dipilih operator (`snapshot_uri_port_not_allowed`), redirect tidak diikuti. Alamat layanan (XAddr) dari perangkat dikunci kembali ke host perangkat.
Batasan: pemeriksaan hanya pada literal IP yang dimasukkan; tidak ada DNS. Allow-list global, belum per tenant.

## D13. CSRF/Origin
- Better Auth menonaktifkan pemeriksaan Origin otomatis bila `NODE_ENV=test`. Sekarang `advanced.disableOriginCheck: false` diset eksplisit sehingga perilaku sama di semua environment, dan diuji (`csrf.int.test.ts`).
- Rute `/v1` memakai cookie sesi tetapi tidak dilindungi Better Auth. Hook `onRequest` di `apps/api/src/app.ts` menolak request tulis (non GET/HEAD/OPTIONS) bila `Origin` ada tetapi tidak tepercaya (termasuk `null`) atau `Sec-Fetch-Site: cross-site`. Request tanpa kedua header diizinkan (klien non-browser; browser selalu mengirim Origin pada tulis lintas-origin). Origin tepercaya = origin `BASE_URL` + `TRUSTED_ORIGINS`.
- Konsekuensi: panggilan `/api/auth/*` ber-cookie wajib mengirim `Origin` (tes dan README disesuaikan).

## D14. Rate limit
Limiter jendela tetap, in-memory, dibatasi memori (`apps/api/src/rate-limit.ts`). Kunci: login/sign-up/ubah/reset sandi = per IP klien **dan** per email; probe (`POST /v1/devices`) dan snapshot = per organisasi+pengguna. Percobaan gagal ikut dihitung; percobaan yang ditolak dicatat di audit (`rate_limited`) dan tidak menyentuh perangkat. Batas bawaan 10/mnt (auth), 10/mnt (probe), 30/mnt (snapshot), bisa diatur lewat env.
Batasan: hanya satu proses (multi-instance butuh penyimpanan bersama); IP klien benar hanya bila `TRUST_PROXY` diatur sesuai proxy; baris audit untuk percobaan yang dibatasi dapat menggelembungkan audit oleh pengguna yang sah-terautentikasi (belum dibatasi).

## D15. Tes tidak bergantung pada `pg_dump`
`pg_dump` klien 16 menolak server 17. Tes "kata sandi tidak ada di seluruh DB" kini memindai semua baris semua tabel `public` lewat SQL (`t::text`), asersinya sama. Cakupan tetap hanya data tabel (bukan berkas WAL/data directory).

## D16. Frontend MVP-1: stack dan deviasi dari PRD (apps/web)
- Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript, sesuai PRD. **Tanpa shadcn/ui**: PRD menyebutnya, tetapi identitas visual buatan sendiri (DESIGN.md) lebih jelas dibangun dari komponen sendiri. Tanpa pustaka data (TanStack Query) dan tanpa Radix: kebutuhan kecil dan terkendali.
- Dialog memakai `<dialog>` native: Escape dan penutupan sudah baku di browser. Siklus fokus (Tab dan Shift+Tab berputar di dalam dialog) dan pengembalian fokus ke pemicu ditulis eksplisit di `apps/web/src/components/ui.tsx` karena dialog native saja tidak menjebak fokus secara siklik, dan fokus tidak kembali bila elemen terfokus dilepas lebih dulu. Keduanya diuji di E2E.
- Browser hanya berbicara ke origin web. Next.js `rewrites` meneruskan `/api/auth/*` dan `/v1/*` ke API, jadi cookie sesi (httpOnly, dari backend) dan pemeriksaan Origin/CSRF backend (D13) tetap berlaku. Tujuan rewrite terpanggang saat build (`PANTAU_API_ORIGIN`). Tanpa token di localStorage, URL, atau JS. `BASE_URL` backend harus sama dengan origin web.
- Respons API divalidasi di browser dengan skema Zod dari `@pantau/contracts` (dipakai langsung, bukan salinan tipe). Respons yang tidak sesuai kontrak menampilkan galat, bukan data setengah benar.
- Font Atkinson Hyperlegible di-host sendiri lewat `@fontsource` (OFL). Tanpa permintaan ke CDN font.
- Tes: unit Vitest di `apps/web/test` (kontras dihitung dari `tokens.css` asli, pemetaan galat, filter, validasi, redirect aman, pemeriksaan higiene antislop), E2E Playwright di `apps/web/e2e` terhadap API nyata dan PostgreSQL nyata. CI memiliki job `e2e` terpisah supaya gerbang backend tidak berubah.

## D17. Kejujuran label di UI
- API menyimpan `status: "online"` pada saat perangkat dibuat. Itu bukan status sekarang, jadi UI tidak menampilkannya dan tidak memakai kata "online". Yang ditampilkan: "Probe terakhir" dengan tanggal penambahan dan catatan bahwa itu hasil probe saat itu.
- Respons snapshot tidak membawa waktu tangkap dari perangkat. UI menampilkan "Diterima di browser {jam}", bukan waktu dari kamera.
- Kemampuan memakai kosakata API (ya, tidak, belum-diuji) sebagai "Terbukti saat probe", "Tidak tersedia", "Belum diuji", selalu dengan glif dan teks. "ptz" tampil sebagai "Konfigurasi PTZ terdeteksi" karena PANTAU belum menyediakan kendali PTZ.
- Snapshot yang gagal tidak pernah tampil sebagai gambar: respons harus `image/jpeg` dan tidak kosong, dan gambar yang gagal dimuat diganti keadaan galat. Gambar sebelumnya dibuang saat pengambilan ulang gagal, supaya gambar lama tidak terbaca sebagai hasil terbaru.
- Nama merek dari API sudah dinormalisasi huruf kecil; UI hanya mengkapitalisasi tampilannya.

## D18. Fitur yang diminta tetapi belum didukung API (dikeluarkan dari UI)
Probe ulang perangkat, ubah atau hapus perangkat, lokasi, atau kamera, status perangkat terkini, waktu tangkap dari perangkat, paginasi dan penyaringan sisi server (daftar dimuat penuh, penyaringan dilakukan di browser), penyaringan audit selain jumlah, manajemen anggota dan undangan, 2FA, grant per kamera. Tidak ada endpoint ditambahkan dan tidak ada migrasi.

## D19. Sesi dan organisasi di UI
- Login baru tidak punya organisasi aktif. Bila pengguna hanya punya satu organisasi, UI mengaktifkannya otomatis lewat `organization/set-active`. Bila lebih dari satu atau nol, UI menampilkan pemilih organisasi.
- Peran dibaca dari `organization/get-active-member-role` dan dipetakan seperti D5. UI menyembunyikan aksi yang tidak diizinkan (tambah perangkat, snapshot, audit), tetapi server tetap yang menegakkan; E2E memaksa endpoint tersebut dan memeriksa 403.
- Respons 401 pada `/v1` mengarahkan ke `/login?expired=1&next=...` dan setelah masuk kembali ke halaman semula. `next` hanya menerima path relatif satu situs.

# Gelombang 2 (M1 selesai, M2 dimulai)

## D20. Peran `noc` dan batas lintas tenant
- PRD bagian 2 punya empat peran. `noc` kini dikenali sebagai nilai `member.role = "noc"` di dalam satu organisasi (tenant). Pemetaan: owner, admin menjadi operator, member menjadi viewer, noc menjadi noc.
- `noc` setara operator untuk inventaris dan konfigurasi (tambah perangkat, ubah lokasi dan kamera), boleh membuat dan mencabut grant, membaca audit, membuat token pendaftaran agen, dan mencabut agen. `noc` **tidak pernah** mendapat akses video, bahkan bila diberi grant (PRD: tidak menonton tanpa sesi dukungan; `support_session` belum ada).
- Belum ada: `noc` lintas tenant (tenant khusus `perumnet-noc` yang menjangkau semua organisasi), sesi dukungan, dan cara memberi peran `noc` lewat UI. Plugin organization Better Auth tidak mengenal peran itu, jadi saat ini peran diberikan lewat baris `member` langsung (dipakai tes). Ini harus dirancang bersama keputusan RLS lintas tenant sebelum M6.
- Endpoint memakai dua cara cek: `requireRole` (urutan viewer < operator = noc < owner) untuk inventaris, dan `requireAny([...])` dengan daftar eksplisit untuk hal yang tidak linear (video tanpa noc, grant hanya owner dan noc).

## D21. Grant per kamera (`camera_grant`): default tolak untuk video
- Aturan: peran menetapkan batas atas, grant mempersempit. **Owner** menjangkau semua kamera di tenant. **Operator** dan **viewer** hanya menjangkau lokasi atau kamera yang diberikan; tanpa grant berarti tidak ada akses video. Izin `view` hanya untuk melihat; `operate` menambah snapshot (nanti PTZ dan putar ulang). Viewer tidak pernah beroperasi, apa pun izin yang tertulis di grant. Grant lokasi berlaku untuk semua kamera di lokasi itu.
- Tidak ada pintu belakang "tanpa grant berarti semua": menghapus grant terakhir tidak boleh melebarkan akses.
- Yang dibatasi grant hanyalah aksi berbau video (kini snapshot; live, PTZ, playback menyusul di M3 dan M5 lewat `cameraAccess` di `apps/api/src/access.ts`). **Daftar** perangkat, kamera, dan lokasi tetap terlihat oleh semua anggota, karena itu inventaris, bukan video. Ini keputusan saya, bukan kutipan PRD; bila Budi ingin daftar kamera juga dipersempit, perubahannya ada di satu tempat per endpoint daftar.
- Perubahan terhadap tes lama: `roles.int.test.ts` kini memberi operator grant `operate` di `beforeAll` (asersinya tidak berubah), dan `access.e2e.ts` melakukan hal yang sama lewat API. Penyebabnya perubahan produk (default tolak), bukan pelemahan.
- Skema: `camera_grant` dengan RLS, kunci asing komposit ke `member(organization_id, user_id)` (grant ikut hilang saat anggota dikeluarkan), trigger `BEFORE DELETE` pada `site` dan `camera` yang menghapus grant yatim (`scope_id` polimorfik, tidak bisa memakai FK). Pembuatan memeriksa bahwa anggota ada di tenant ini dan target ada di tenant ini (404 lintas tenant).
- `GET /v1/grants`: owner dan noc melihat seluruh tenant; peran lain hanya grant milik sendiri (meminta `userId` orang lain menjadi 403).

## D22. Dua langkah (2FA)
- Plugin `twoFactor` Better Auth 1.7.7: TOTP dan kode cadangan (rahasia dan kode cadangan terenkripsi oleh Better Auth; tes memeriksa tidak ada yang polos di DB atau log). Aktivasi tidak berlaku sampai satu kode terkonfirmasi (`skipVerificationOnEnable` tidak dipakai); pendaftaran setengah jalan tidak mengunci pengguna. Setelah aktif, `sign-in/email` tidak membuat sesi, hanya cookie tantangan sepuluh menit; sesi baru lahir saat kode benar. Better Auth sendiri membatasi 10 kegagalan beruntun dengan kunci akun 15 menit; endpoint verifikasi juga masuk pembatas laju per IP.
- "2FA wajib untuk peran yang bisa melihat video" (PRD 11): `REQUIRE_2FA_FOR_VIDEO`, bawaan **nyala di production**, mati di development dan test. Saat nyala, snapshot ditolak (`two_factor_required`) bagi pengguna tanpa 2FA terkonfirmasi. Titik pasang yang sama dipakai live, PTZ, dan playback nanti. Mengapa tidak selalu nyala: seluruh tes dan demo lama tidak punya 2FA.
- Belum: kejadian 2FA (aktifkan, matikan, kode salah) tidak masuk `audit_log` karena itu tingkat pengguna dan dikelola Better Auth, sedangkan `audit_log` terikat organisasi. Perlu keputusan: audit pengguna tanpa organisasi.
- UI tidak menawarkan "percayai perangkat ini" (cookie tepercaya Better Auth) agar tiap login tetap meminta kode.

## D23. Katalog aksi audit
`AUDIT_ACTIONS` di `packages/contracts` adalah satu-satunya daftar nama aksi; `writeAudit` hanya menerima nama dari daftar itu (tes unit memindai kode agar tidak ada nama liar). `recordCameraAccess` menjadi pintu tunggal untuk `camera.view.start`, `camera.view.stop`, `camera.ptz`, `camera.playback.start`, `camera.playback.stop`, sehingga endpoint live, PTZ, dan playback tidak bisa lupa mencatat. Kunci meta yang dilarang (`password`, `token`, `authorization`, `secret`, `credentials`, `rtsp`, `cookie`, `apikey`) membuat penulisan gagal. `GET /v1/audit` mendapat filter `action`, `from`, `to`; owner dan noc boleh membacanya (PRD 9.1).

## D24. `/healthz` dan `/readyz`
`/healthz` tidak menyentuh apa pun. `/readyz` menjalankan daftar pemeriksaan bernama di bawah satu batas waktu (`READINESS_TIMEOUT_MS`, bawaan 2 dtk); basis data terdaftar sendiri. 503 hanya memuat nama pemeriksaan yang gagal, tidak pernah pesan galat. pg-boss **belum ditambahkan** (belum ada worker); saat ada, ia memanggil `readiness.register("queue", ...)`, dan tes sudah membuktikan pemeriksaan tambahan ikut menentukan 200 atau 503.

## D25. Protokol agen: yang ditambahkan di luar PRD 9.2
- **Pendaftaran lewat REST**: `POST /v1/agent/enroll` dengan `Authorization: Enroll <token>` (PRD hanya menyebut token pendaftaran, tidak menyebut jalurnya). Token pendaftaran `pae_...` berlaku 24 jam dan sekali pakai; token agen `pat_...` berumur panjang dan dapat dicabut. Keduanya 256 bit acak, **hanya SHA-256-nya yang disimpan**, dan tidak pernah tampil lagi, dicatat, atau masuk audit. Klaim token adalah satu `UPDATE ... WHERE used_at IS NULL AND expires_at > now()`: dari sekian pendaftaran serempak, tepat satu yang menang (diuji dengan 6 permintaan paralel). Token yang dikenal tetapi terpakai atau kedaluwarsa dicatat sebagai `agent.enroll.failed` (alasan `used` atau `expired`, tanpa token); token yang tidak dikenal tidak punya tenant untuk dikaitkan sehingga hanya ditolak 401 dan dibatasi laju.
- **Mencari agen sebelum tenant diketahui**: agen hanya membawa token. Policy RLS `token_lookup` (SELECT saja) menampakkan tepat satu baris yang hash-nya cocok dengan `app.token_hash` transaksi; tanpa setelan itu tidak ada baris. Tidak ada peran khusus dan tidak ada `BYPASSRLS`. Tes memastikan bahwa dengan hash itu UPDATE dan DELETE tidak mengenai apa pun.
- **Tambahan pesan**: `ack` dan `error` dari server (dengan `id` permintaan yang dijawab), serta `ptz.command.result` dan `snapshot.request.result` dari agen. Kode galat: `invalid_message`, `invalid_payload`, `forbidden_field`, `unsupported_type`, `hello_required`, `unexpected_result`, `internal_error`. `event.motion` sudah punya skema tetapi ditolak `unsupported_type` sampai M4.
- **Bingkai itu metadata saja**: setiap objek `strict`; tidak ada kolom untuk kredensial, URI stream, atau token. Selain itu pemindaian kunci terlarang di kedalaman berapa pun menolak bingkai sebelum divalidasi (`forbidden_field`), dan nilai yang dikirim tidak pernah dipantulkan ke dalam pesan galat.
- **Ketahanan**: bingkai maks 128 KB (lebih besar menutup dengan 1009), hanya teks, 5 bingkai tidak valid beruntun menutup dengan 1008, pembatas laju per koneksi (60 pesan per 10 dtk, bisa diatur), ping server tiap 20 dtk (`AGENT_PING_INTERVAL_MS`) dan koneksi yang tidak membalas pong diputus, koneksi kedua dengan token yang sama menggantikan yang pertama (4409), pencabutan menutup koneksi dengan 4401 dan agen berhenti mencoba lagi.
- **Kehadiran**: status `online` berasal dari soket yang hidup di proses ini (`AgentHub`), jadi satu proses API. Beberapa instans memerlukan penyimpanan kehadiran bersama (pg-boss atau LISTEN/NOTIFY), belum dibuat.
- **Kunci publik agen**: pasangan Ed25519 dibuat agen, kunci publik disimpan dan hanya sidik jarinya (16 heksa) yang tampil. Belum dipakai untuk menandatangani apa pun; itu untuk fase berikut.

## D26. Inventaris dari agen
- `inventory.sync` adalah gambaran penuh. Perangkat atau kamera yang tidak lagi dilaporkan **tidak dihapus** (grant dan riwayat bergantung padanya) tetapi ditandai `missing`, dan kembali `unknown` bila dilaporkan lagi. Nama kamera dan urutan sepenuhnya milik operator sesudah kamera ada (`PATCH /v1/cameras/:id` tidak ditimpa oleh sinkron berikutnya); kodek dan `hasPtz` mengikuti agen.
- Status kamera dari agen: `unknown` saat dibuat, lalu `online` atau `offline` dari bingkai `status` (keterjangkauan TCP ke port ONVIF perangkat, tanpa kredensial); `device.status` mengikuti. Sebuah perangkat dari agen tidak punya baris `device_secret`.
- Jalur langsung (D1: API menyimpan kredensial terenkripsi) **masih ada** sebagai jembatan sementara dan tidak diubah; PRD A2 baru terpenuhi untuk perangkat yang masuk lewat agen. Snapshot untuk kamera dari agen: lihat D32 (sudah ada sejak gelombang 3).
- `device.agent_id` dan `agent_device_key` dibuat berpasangan (CHECK) dan unik per agen; dua agen boleh memakai `deviceKey` yang sama tanpa bertabrakan.

## D27. Agen di lokasi (`apps/agent`)
- Proses Node terpisah, hanya koneksi keluar. Berkas di direktori data (0700): `identity.json` dan `agent.key` (0600), `devices.json` (0600, metadata), `vault/vault.key` dan `vault/vault.json` (0600). Vault: AES-256-GCM, kunci dari berkas sendiri, nonce acak tiap tulis, nama perangkat ikut diautentikasi (blob tidak bisa dipindah ke perangkat lain), menolak berjalan bila `vault.key` terbaca grup atau lainnya.
- Perangkat ditambahkan di agen: kebijakan target yang sama dengan API (dipindah ke `@pantau/adapters`; `apps/api/src/target-policy.ts` kini hanya re-export), probe ONVIF baca-saja, kredensial ke vault, metadata ke inventaris. Gagal probe tidak meninggalkan apa pun. Galat yang diteruskan hanya kode stabil, bukan pesan pustaka (pesan bisa memantulkan kredensial).
- Klien WS: `Authorization: Agent <token>`, hello lalu tunggu ack lalu `inventory.sync`, status tiap 30 dtk, ping 20 dtk dengan batas pong, ack 5 dtk, sambung ulang eksponensial 1 sampai 60 dtk dengan jitter plus minus 20 persen (fungsi murni, diuji batasnya untuk 200 percobaan dan semua tarikan acak), hitungan percobaan kembali ke nol setelah siap. 401 saat jabat tangan atau penutupan 4401 berarti dicabut: agen berhenti, tidak menghantam server. Perintah dari API dijawab dalam batas waktu per jenis (PTZ 3 dtk, snapshot 5 dtk, pencarian 15 dtk); tanpa handler dijawab `unsupported`; handler yang melempar hanya menghasilkan `failed`.
- URL API wajib `https`/`wss` kecuali loopback atau `PANTAU_ALLOW_INSECURE=true` (lab). `PANTAU_ALLOW_LOOPBACK=true` hanya untuk simulator.
- **Dikerjakan di gelombang 3**: WS-Discovery (D33), go2rtc loopback (D34), onboarding lokal (D35), installer dan image (D36). Tidak ada kamera fisik yang diuji; semua memakai simulator berlabel Simulasi.

## D28. Perubahan tampilan yang ikut
- Halaman baru: Keamanan, Akses, Agen. Bilah atas kini boleh membungkus baris: penambahan tautan membuat audit tata letak menemukan overflow horizontal di lebar 768 px dan itu diperbaiki, bukan dilonggarkan.
- Tombol primer tidak lagi menganimasikan latarnya: tombol yang berganti dari nonaktif ke aktif menampilkan frame berkontras 1,04:1 (latar masih gelap, teks sudah berganti). Tes per frame (`states.e2e.ts`) membuktikan cacat itu pada kode lama dan kini hijau. Audit tata letak menunggu transisi selesai agar hasilnya deterministik; frame antara dijaga tes tersendiri.
- Kotak centang dan radio dihitung dari kotak label (target sentuh 44 px), karena label memang yang dapat disentuh.

## D29. Infrastruktur tes
`fileParallelism: false` di dalam proyek integrasi Vitest ternyata **diabaikan** (opsi itu hanya berlaku di akar); 16 pasang berkas berjalan serempak pada satu database. Itu tidak pernah merusak tes lama (masing-masing memakai tenant sendiri) tetapi membuat asersi jumlah global tidak stabil: satu tes baru gagal 2 dari 3 run. Opsi dipindah ke akar (`vitest.config.ts`), terbukti 0 pasang tumpang tindih, dan integrasi tetap selesai sekitar 1 menit. Asersi jumlah di tes agen juga dibatasi per tenant.

## D30. Pertanyaan terbuka (tidak dilakukan)
Menaikkan vitest 3 ke 4 untuk menutup 2 temuan moderate (GHSA-82fw-gwwq-j7x9, hanya di `better-auth/dist/test-utils`, bukan runtime) **belum dilakukan** dan menunggu jawaban Budi. Audit penuh: 2 moderate (vitest, @vitest/mocker) dan 1 low (esbuild), semuanya jalur dev atau peer tes.

## D31. Grant berlaku pada seluruh akses perangkat dan kamera tenant (gelombang 3)
- Operator dan penonton **tidak melihat apa pun** tanpa grant: daftar dan detail lokasi, perangkat, dan kamera disaring di server (`visibleScope`, `siteFilter`, `deviceFilter`, `cameraFilter` di `apps/api/src/access.ts`). Objek yang tidak terlihat dijawab 404, bukan 403, agar keberadaannya tidak bocor. Owner melihat semua; noc melihat inventaris dan konfigurasi tenantnya (tanpa video), dan RLS untuk noc tidak dilonggarkan.
- Menulis butuh izin operate: `POST /v1/devices` butuh operate pada lokasi (403 `site_not_granted`), `PATCH /v1/sites/:id` butuh operate pada lokasi, `PATCH /v1/cameras/:id` butuh operate pada kamera (403 `camera_not_granted`). Operator yang membuat lokasi otomatis diberi grant operate pada lokasi itu (audit `grant.create`, `reason: site_creator`), kalau tidak ia tidak bisa memakai lokasinya sendiri.
- Detail perangkat hanya memuat kamera yang terlihat. Grant kamera tidak membuka kamera lain pada perangkat yang sama.
- UI hanya menyembunyikan dan menjelaskan. Daftar kosong untuk non-owner berbunyi "Belum ada perangkat yang bisa Anda lihat." dan menunjuk halaman Akses.
- Tes: `inventory-grants.int.test.ts` (12) dibuktikan merah sebelum kodenya. Penyiapan 6 tes lama diberi grant lewat `giveAccess`; asersinya tidak diubah. Lima E2E diperbarui karena perilaku memang berubah (tanpa grant perangkat tidak ada, bukan tombol nonaktif); asersi baru lebih ketat (daftar API kosong, halaman 404).

## D32. Snapshot lewat agen
- Untuk kamera yang berasal dari agen, API mengirim `snapshot.request` dengan payload hanya `{deviceKey, channel}`: tanpa alamat dan tanpa kredensial. Agen mengambil kredensial dari vault, memanggil ONVIF di LAN, dan membalas JPEG base64.
- Batas: gambar maks 1 MiB. Bingkai `snapshot.request.result` boleh sampai `MAX_SNAPSHOT_FRAME_BYTES` (sekitar 1,37 MB); semua bingkai lain tetap 128 KB. Lebih besar menutup dengan 1009. Hasil gagal tidak boleh membawa gambar.
- Kode galat: agen offline 503 `agent_offline`, agen diam 504 `agent_timeout` (`AGENT_SNAPSHOT_TIMEOUT_MS`, bawaan 5000), kamera `missing` 409 `camera_missing`, kode perangkat dipetakan lewat `fromAdapterCode`, `snapshot_too_large` dan jawaban tak terpakai 502. Byte yang bukan JPEG (SOI ff d8 ff dan EOI ff d9) ditolak 502 `snapshot_invalid_image`.
- Otorisasi tidak berubah: owner atau operator, 2FA bila diwajibkan, grant operate, pembatas laju, audit dengan `via: agent`. Agen ditanya hanya setelah semua pemeriksaan itu lulus. Hasil yang tidak diminta diabaikan.
- Bukti: `agent-snapshot.int.test.ts` (13) lewat relay WS perekam, dengan pemindaian sentinel sandi di DB, log, bingkai, dan berkas.

## D33. WS-Discovery (`apps/agent/src/discovery.ts`)
- Satu Probe UDP multicast ke 239.255.255.250:3702, TTL 1 (tidak melewati router), baca saja, tanpa sandi. Jawaban harus `RelatesTo` ke MessageID kita.
- XAddr dipercaya hanya bila http ke IP literal yang sama dengan pengirim paket, tanpa userinfo, dan lolos `checkTarget`. Alamat lain (misalnya pengalihan ke host lain atau metadata cloud) dibuang. DOCTYPE dan ENTITY ditolak, datagram maks 16 KB, hasil didedup dan dibatasi 64, nama dan lokasi dibersihkan dari karakter kontrol.
- Bukan parser XML sengaja: hanya beberapa bidang yang diambil, jadi tidak ada ekspansi entitas dan tidak ada fetch eksternal.
- Diuji dengan responder UDP Simulasi (`packages/mock-onvif/src/discovery.ts`). Belum diuji pada jaringan dengan kamera nyata.

## D34. go2rtc terikat loopback (`apps/agent/src/go2rtc.ts`)
- go2rtc meloloskan permintaan dari localhost tanpa otorisasi, jadi hanya proses agen yang boleh bicara dengannya dan ia tidak pernah dibuka ke LAN atau internet. Config yang ditulis ke disk hanya berisi pendengar `127.0.0.1` (api 1984, rtsp 8554, webrtc 8555) dan `local_auth: true`; tidak ada stream, tidak ada kredensial.
- Sumber stream (yang memuat kredensial) hanya didorong lewat API lokal dari memori. Klien menolak base URL yang bukan http ke loopback tanpa userinfo, menolak nama stream di luar `[A-Za-z0-9_-]{1,64}`, hanya meneruskan sumber `rtsp://` atau `rtsps://` (go2rtc juga menerima `exec:` dan `ffmpeg:`, yang menjalankan perintah), dan pesan galatnya tidak memuat URL.
- **Belum dibuat**: supervisor proses go2rtc dan alur live ke penonton. Tes memakai server HTTP Simulasi; biner go2rtc asli tidak ada di lingkungan ini dan tidak diunduh.

## D35. Onboarding lokal agen (`pantau-agent setup`)
- Server HTTP di agen, bawaan `127.0.0.1:8780` (`PANTAU_LOCAL_BIND`, `PANTAU_LOCAL_PORT`). Alamat bind hanya boleh loopback atau IP LAN privat literal; `0.0.0.0`, `::`, nama host, dan IP publik ditolak.
- Masuk dengan PIN 8 digit acak yang dicetak ke konsol saja (bukan logger, bukan berkas, bukan cloud). Perbandingan waktu konstan, 5 salah beruntun mengunci 60 detik. Cookie `HttpOnly; SameSite=Strict`, sesi di memori, token CSRF per sesi, pemeriksaan `Host` (421, menahan DNS rebinding) dan `Origin` pada setiap tulis, JSON saja, badan maks 8 KB, CSP `default-src 'none'` dengan nonce, `no-store`.
- Alur: cari (WS-Discovery) atau isi manual, isi nama pengguna dan sandi, agen menguji lewat `DeviceRegistry`, sandi langsung ke vault, hanya metadata yang kembali. Isian sandi dikosongkan setelah tiap percobaan. Galat hanya berupa kode stabil; badan permintaan tidak pernah dipantulkan.
- Halaman memakai token DESIGN.md yang disalin ke CSS inline karena CSP ketat; tema mengikuti sistem (tanpa tombol, jadi tanpa localStorage). Font Atkinson tidak dimuat dari jaringan; tanpa font itu tampilan jatuh ke font sistem.
- **Bind di luar loopback wajib TLS** (keputusan Budi): `startLocalUi` menolak IP LAN tanpa `PANTAU_LOCAL_TLS_CERT` dan `PANTAU_LOCAL_TLS_KEY` (galat `bind beyond loopback needs TLS`), jadi PIN dan sandi tidak pernah lewat LAN sebagai plaintext. Dengan TLS: https, cookie `Secure`, Origin harus https. Akses jarak jauh lain memakai terowongan aman ke alamat loopback. Berkas deploy tidak pernah menyetel bind selain 127.0.0.1 (tes). Bind LAN dengan TLS belum dicoba pada antarmuka LAN nyata; tes TLS berjalan di loopback dengan sertifikat swa-tanda tangan Simulasi.

## D36. Installer dan image agen (`deploy/agent`)
- Dockerfile (non-root uid 10001, tanpa `EXPOSE`), compose (`network_mode: host` agar WS-Discovery dan kamera terjangkau, `read_only`, `cap_drop: ALL`, `no-new-privileges`, bind lokal tetap loopback), unit systemd dengan hardening, dan `install.sh` (wajib https, token pendaftaran dibaca tanpa echo dan tidak pernah ditulis ke disk, berkas env hanya memuat alamat).
- **Tidak dibangun dan tidak dijalankan**: lingkungan ini tidak punya daemon Docker dan tidak ada host systemd. Yang dibuktikan hanya tes statis (`deploy.unit.test.ts`, 7): sintaks `bash -n`, tidak ada `0.0.0.0`, tidak ada rahasia, kunci hardening ada, token tidak masuk berkas env. Image belum dipin ke digest.

## D37. Pertanyaan yang masih terbuka
- Vitest 3 ke 4 tetap tidak dilakukan (D30).
- Nasib PR #4 (Rex) dan PR #5: bentrok, tidak digabung, tidak ditutup.
- Bentuk `noc` lintas tenant dan kejadian audit 2FA.
- Integrasi Hik-Connect tetap rencana yang belum dibuktikan; tidak ada kode, akun, atau API vendor yang disentuh.

## D38. Vitest 3 ke 4 (cabang terpisah, izin Budi)
Dikerjakan di `claude/pantau-vitest-4`, terpisah dari PR fitur. `vitest` `^3.2.0` menjadi `^4.1.11` (terpasang 4.1.11), tanpa perubahan konfigurasi atau tes. `pnpm audit`: sebelum 3 temuan (2 moderate: vitest dan @vitest/mocker, GHSA-82fw-gwwq-j7x9; 1 low: esbuild di tsup), sesudah 1 temuan (low: esbuild lewat `apps/agent>tsup`, tidak terkait Vitest). Gerbang lokal tidak berubah: unit 304, integrasi 251, E2E 73, lint, typecheck, build hijau (Node 22 + PG16).

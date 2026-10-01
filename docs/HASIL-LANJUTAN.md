# HASIL-LANJUTAN: PANTAU MVP-0, putaran pengerasan

Tanggal: 2026-10-01. Semua angka berasal dari eksekusi di sesi cloud ini. Kamera fisik, frontend, live CCTV, dan kesiapan produksi **tetap BELUM TERVERIFIKASI**; dokumen ini tidak menyatakan aplikasi siap produksi.

## 1. Model dan HEAD

- Model: `claude-sonnet-5-5` (sesi yang sama; `get_session` sebelumnya menunjukkan `configured_model` = `last_served_model` = `claude-sonnet-5-5`).
- HEAD awal: `6985591748f4ca9f570caeda7862befc5dadd5e6` (branch `claude/vibrant-ptolemy-4vr7cj`; remote tidak punya commit baru setelahnya, `git status` bersih).
- Branch kerja: `claude/pantau-hardening` (baru, non-default; repo hanya punya branch ini dan pendahulunya, tidak ada branch default sehingga PR memakai branch pendahulu sebagai basis).
- Commit kode: `72c0a719a342ce901f254ba390efcf5678bae80a`. HEAD akhir = commit yang memuat berkas ini (lihat `git log` / PR [air-buddy410/monitoring-CCTV#1](https://github.com/air-buddy410/monitoring-CCTV/pull/1)).

## 2. Environment dan perintah

| Stack | Versi |
|---|---|
| Baseline | Node v22.22.0, pnpm 10.28.0, PostgreSQL 16.14 (paket Ubuntu, sistem) |
| Target PRD | **Node v24.21.0** (paket npm `node@24`, hanya di PATH proses uji) + **PostgreSQL 17.10** (binari dari paket npm `@embedded-postgres/linux-x64@17.10.0-beta.17`, cluster terpisah di port 5433, direktori `/tmp/pg17`; PG16 sistem tidak disentuh) |

Catatan: PG17 ini bukan build distro/Docker resmi; ia build biner PostgreSQL dari paket komunitas. Ini cukup untuk menguji RLS, role, trigger, dan SQL aplikasi pada mesin 17.x, tetapi bukan image `postgres:17` yang dipakai CI.

### Tahap 1: baseline pada HEAD awal (Node 22 + PG16), instalasi bersih
| Perintah | Exit | Hasil |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm lint` | 0 | 63 berkas |
| `pnpm typecheck` | 0 | |
| `pnpm test:unit` | 0 | **57 lulus**, 5 berkas |
| `pnpm test:integration` | 0 | **47 lulus**, 7 berkas |
| `pnpm build` | 0 | |

Klaim "57 + 47" **terbukti ulang, tanpa selisih**.

Perubahan tes sejak commit merah `5f6da97` (diperiksa dengan `git diff -w` dan perbandingan jumlah `expect(`/`it(`):
- 8 berkas: hanya format/urutan impor oleh Biome; jumlah asersi identik (`rls`, `audit`, `device-flow`, `tenant-isolation`, `openapi`, `redaction`, `target-policy`, `whitelist`). Dipertahankan.
- `onvif-guard`: argumen `SetSystemDateAndTime` dibuat valid agar guard benar-benar teruji; asersi sama. Dipertahankan.
- `secrets`: pemeriksaan `"password"` pada `/docs/json` dipersempit karena dokumen memang menamai field *input*; digantikan tes baru yang memeriksa **skema respons** OpenAPI tidak memuat `password/username/credential(s)`, dan sentinel tetap dicek di dokumen itu. Setara atau lebih ketat, bukan lebih lemah.

### Tahap 2: target PRD
Pada Node 24.21.0 + PG 17.10 suite lama awalnya menghasilkan 46/47: satu gagal karena `pg_dump` 16 menolak server 17 (masalah alat, bukan produk). Tes itu diganti dengan pemindaian SQL semua baris semua tabel `public` (asersi sama: sentinel, base64-nya, dan kata sandi login tidak ada; `device_secret` dan `audit_log` harus berisi baris). Setelah itu 47/47 pada PG 17.

### Hasil akhir setelah semua perubahan (instalasi bersih di kedua stack)
| Perintah | Node 24.21 + PG 17.10 | Node 22.22 + PG 16.14 |
|---|---|---|
| `pnpm install --frozen-lockfile` | exit 0 | exit 0 |
| `pnpm lint` | exit 0 | exit 0 |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm test:unit` | exit 0, **66 lulus / 0 gagal** (6 berkas) | exit 0, **66 / 0** |
| `pnpm test:integration` | exit 0, **112 lulus / 0 gagal** (12 berkas) | exit 0, **112 / 0** |
| `pnpm build` | exit 0 | exit 0 |
| `pnpm openapi:export` | exit 0 | (diekspor sekali; `docs/openapi.json` diperbarui, tambah 429) |

Tes baru: unit +9 (target policy 5, rate limiter 4); integrasi +65 (csrf 8, roles 36, ssrf 11, rate-limit 6, secrets-errors 4; penggantian `pg_dump` tidak mengubah jumlah). Bukti "merah dulu": sebelum implementasi, suite menghasilkan 3 kegagalan unit + 1 berkas unit gagal dimuat (modul `rate-limit` belum ada) dan 15 kegagalan integrasi (CSRF 6, rate limit 4, SSRF 3, peran 1, rahasia 1). Beberapa tes baru sengaja berupa *karakterisasi* dan sudah hijau sebelum perbaikan (pin XAddr, redirect tidak diikuti, matriks peran); tes itu menjaga perilaku yang sudah benar agar tidak mundur.

## 3. Temuan keamanan dan perbaikan

| # | Temuan | Perbaikan (berkas) | Tes |
|---|---|---|---|
| F1 (sedang) | Better Auth melewati pemeriksaan Origin/CSRF bila `NODE_ENV=test` (`skipOriginCheck = isTest()`); perilaku keamanan bergantung pada sniffing env dan tak pernah teruji | `advanced.disableOriginCheck: false` eksplisit: `packages/auth/src/index.ts` | `csrf.int.test.ts` |
| F2 (sedang) | Rute `/v1` memakai cookie sesi tetapi tanpa perlindungan CSRF sama sekali | Hook `onRequest`: Origin tak tepercaya / `null` / `Sec-Fetch-Site: cross-site` pada request tulis ditolak 403 `csrf_origin_rejected`: `apps/api/src/app.ts`; `config.ts` (`TRUSTED_ORIGINS`) | `csrf.int.test.ts` |
| F3 (sedang) | Target perangkat: alamat publik diizinkan (API cloud bisa dipakai memindai internet) | Allow-list eksplisit, bawaan RFC1918 + `fc00::/7`; daftar tolak mutlak (link-local, metadata, multicast, `::`); loopback hanya flag lab; IPv4-mapped di-unwrap; ejaan IP non-kanonik ditolak: `apps/api/src/target-policy.ts`, `config.ts` (`TARGET_ALLOW_CIDRS`) | `target-policy.unit.test.ts`, `ssrf.int.test.ts` |
| F4 (sedang) | Snapshot URI boleh memakai port apa pun pada host perangkat (mis. layanan lain di host yang sama) | Port hanya 80/443/port ONVIF; kode `snapshot_uri_port_not_allowed`: `packages/adapters/src/onvif-generic.ts`, `packages/contracts/src/index.ts`, `apps/api/src/errors.ts` | `ssrf.int.test.ts` |
| F5 (sedang) | Tidak ada rate limit pada login/sign-up, probe, snapshot | Limiter jendela tetap, terbatas memori: `apps/api/src/rate-limit.ts`; dipasang di `app.ts` (auth: per IP + per email), `routes/devices.ts`, `routes/snapshot.ts`; 429 + `Retry-After`; percobaan tertolak diaudit dan tidak menyentuh perangkat | `rate-limiter.unit.test.ts`, `rate-limit.int.test.ts` |

Sudah benar sebelum putaran ini dan kini dijaga tes: XAddr yang diiklankan perangkat dikunci ke host perangkat (decoy tidak pernah dihubungi); redirect HTTP tidak diikuti; skema non-http ditolak; viewer tidak bisa menaikkan perannya lewat `/api/auth/organization/update-member-role` / `invite-member`; set-active ke org asing ditolak dan gagal tertutup; error/validasi/fault perangkat yang menggemakan kata sandi tidak bocor ke respons, log, atau audit; error 500 generik.

Pengamatan: setelah set-active ke org asing yang ditolak, Better Auth mengosongkan org aktif sesi, sehingga request berikutnya 403 `no_active_organization` (aman; tes mendokumentasikan ini).

### Audit dependensi (`pnpm audit`, 283 dependensi)
| Tingkat | Paket | Jalur | Perbaikan tersedia | Keterjangkauan |
|---|---|---|---|---|
| moderate | `vitest` (GHSA-82fw-gwwq-j7x9) | root devDependency | >= 4.1.11 (major 3 -> 4) | Hanya alat uji; butuh `vi.mock` redirect dengan path dari penyerang. Tidak ada di `apps/api/dist`. Tidak terjangkau dari produk |
| moderate | `@vitest/mocker` (advisori yang sama) | via vitest | idem | idem |
| low | `esbuild` 0.27.x (GHSA-g7r4-m6w7-qqqr) | `tsup` | >= 0.28.1 | Hanya dev server di Windows; dipakai sebagai bundler di Linux/CI. Tidak terjangkau |

0 high, 0 critical. Tidak ada upgrade major dan tidak ada `audit fix --force`. Rekomendasi: upgrade vitest ke 4.x dalam PR tersendiri dengan menjalankan seluruh suite.

## 4. Perubahan tes dan alasannya (ringkas)
- Baru: `csrf`, `roles`, `ssrf`, `rate-limit`, `secrets-errors` (integrasi); `rate-limiter` (unit); tambahan di `target-policy.unit.test.ts` (tes lama tidak diubah).
- `secrets.int.test.ts`: `pg_dump` -> pemindaian SQL (alasan: klien 16 vs server 17).
- `helpers.ts`: batas laju default longgar untuk tes biasa; panggilan `/api/auth` ber-cookie mengirim `Origin` (konsekuensi F1, bukan pelemahan).
- Dua tes baru saya koreksi sebelum pernah hijau karena asumsi saya keliru, bukan karena perilaku: (a) `roles`: setelah set-active ditolak sesi kehilangan org aktif (403, bukan "tetap 200"); asersi kini: 200 hanya untuk org sendiri atau 403 fail-closed; (b) `secrets-errors`: pemeriksaan kata "credentials" mengenai judul galat saya sendiri; diganti memeriksa username/kata sandi yang digemakan perangkat tidak muncul. Satu asersi hampa dibuang. Tidak ada tes yang dihapus, di-skip, atau dilonggarkan.
- Batas dua percobaan tidak terlampaui.

## 5. CI
- Berkas: `.github/workflows/ci.yml`: Node 24, service `postgres:17` (kredensial dummy khusus job), `permissions: contents: read`, `pnpm install --frozen-lockfile`, lint, typecheck, unit, integration, build; tanpa `continue-on-error`, tanpa secrets, tanpa deploy.
- Run (push, commit `72c0a71`): https://github.com/air-buddy410/monitoring-CCTV/actions/runs/36813212128 : job `verify` **success**, semua langkah (Install, Versions, Lint, Typecheck, Unit, Integration, Build) success.
- Run (pull_request): https://github.com/air-buddy410/monitoring-CCTV/actions/runs/36813223145 : **success**.
- Dari log run push: `node v24.21.0`, pnpm 10.28.0, `PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2)` (image resmi `postgres:17`), unit 6 berkas / **66 lulus**, integrasi 12 berkas / **112 lulus**, build sukses. Hasil CI identik dengan hasil lokal.
- Catatan: peringatan GitHub bahwa action `checkout/setup-node/pnpm-action-setup` v4 menargetkan Node 20 dan dipaksa ke Node 24; belum di-pin ke SHA (versi tag saja).
- Migrasi dan 112 tes berjalan terhadap PG 17.11 resmi, jadi klaim "PG17 lulus" kini didukung oleh run CI, bukan hanya biner komunitas lokal.

## 6. BLOCKED atau belum terverifikasi
- Kamera/NVR fisik, kompatibilitas firmware nyata: BELUM TERVERIFIKASI (mock buatan sendiri).
- Frontend, live video, playback, event: tidak ada / di luar lingkup.
- Docker: tidak digunakan secara lokal (sesuai batas); image `postgres:17` hanya berjalan di CI GitHub (runner milik GitHub, bukan layanan pengguna).
- PG 17 lokal berasal dari biner komunitas npm, bukan paket resmi (lihat §2); verifikasi PG 17 resmi = run CI di §5.
- Action GitHub belum di-pin ke SHA commit.
- Rate limit: hanya satu proses; IP klien bergantung `TRUST_PROXY`; audit untuk percobaan terbatas dapat membengkak. Belum ada uji beban.
- SSRF: kebijakan global, belum per tenant; hanya literal IP, tanpa DNS.
- Allow-list tidak memeriksa port perangkat ONVIF itu sendiri (operator bebas memilih port pada IP yang diizinkan).
- Vault kredensial masih di cloud (D1), tidak diubah sesuai batas putaran ini.
- Dependensi dev rentan (vitest, esbuild) belum di-upgrade (§3).
- Kesiapan produksi: BELUM TERVERIFIKASI (tidak ada uji beban, pemindaian keamanan menyeluruh, pemantauan, backup/restore).

# Petunjuk kerja

Ringkas dan hanya untuk repo ini. Instruksi pengguna dan tugas yang sedang berjalan mengungguli berkas ini.

## Perintah

- Pasang: `pnpm install --frozen-lockfile`
- Cek: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build`
- E2E browser: `pnpm test:e2e` (butuh PostgreSQL, lihat `docs/DEMO.md`)
- Demo lokal: `pnpm demo` (mock ONVIF berlabel Simulasi, lihat `docs/DEMO.md`)
- Verifikasi penuh: `pnpm verify`

## Aturan

- Backend (`apps/api`, `packages/*`) tidak diubah untuk mempercantik UI. Fitur yang belum didukung API dikeluarkan dari UI dan dilaporkan.
- Tes tidak dihapus, di-skip, atau dilemahkan agar hijau.
- Hanya kredensial dummy. Jangan menaruh sandi perangkat atau token sesi di localStorage, URL, log, atau dokumen.
- Otorisasi ditegakkan server. UI hanya menyembunyikan tindakan.
- Tema terang dan gelap harus sama-sama berfungsi. Kontras dihitung, bukan dinilai mata.

## Arah desain

Baca `DESIGN.md` sebelum mengubah antarmuka (token warna di `apps/web/src/app/tokens.css`). Teks yang ditulis agen tidak memakai em dash. Komentar kode satu baris dan hanya menjelaskan alasan.

## Skill antislop

Skill antislop dipasang per sesi di `~/.claude/skills/` dari salinan yang disediakan pemilik. Lisensi redistribusinya belum diperiksa, jadi berkasnya tidak disalin ke repo ini.

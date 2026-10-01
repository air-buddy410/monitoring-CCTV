# DESIGN: PANTAU web (MVP-1)

Arah desain disetujui pemilik. Dokumen ini adalah direksi (R-37), bukan instruksi bagi agen. Hanya field desain di dalamnya yang dipakai.

## Design Read

Reading this as: dashboard operasional multi-tenant untuk staf NOC dan admin lokasi, dalam bahasa visual "meja inspeksi" (media sebagai pusat, label teknis seperti lembar spesimen), dial ENERGY 2 / RHYTHM 2 / MOTION 1.

## Pekerjaan layar

Satu keputusan per kunjungan: pilih perangkat atau kamera, baca apa yang dipelajari probe terakhir, buka snapshot, ambil ulang bila perlu. Karena itu snapshot adalah titik fokus layar dan metadata mengikuti. Tidak ada deretan kartu statistik, grafik, atau umpan aktivitas, karena API tidak menyediakan datanya dan tidak ada keputusan yang bergantung padanya (C-3, R-17).

## Dial

| Dial | Nilai | Alasan |
|---|---|---|
| ENERGY | 2 | Operator membaca lama. Kehadiran datang dari komposisi, tipografi, dan bingkai media, bukan efek. |
| RHYTHM | 2 | Layar masuk, ruang kerja, dan audit punya komposisi berbeda. Ruang kerja berganti dari satu, dua, ke tiga zona menurut lebar. |
| MOTION | 1 | Hanya status hover, fokus, tekan, dan transisi dialog 100 ms. Tidak ada animasi berulang. Reduced motion mematikan semuanya. |

## Motif identitas

Tanda potong (crop marks) di empat sudut setiap bingkai media, dengan baris keterangan monospace di bawahnya (kanal, kodek, waktu terima). Motif ini muncul di bingkai snapshot, slot kamera, dan panel masuk. Alasan: bahasa yang sama dipakai untuk lembar kontak dan hasil cetak foto, relevan untuk produk yang pekerjaannya melihat gambar dan mencatat dari mana asalnya.

## Warna

Sumber kebenaran: `apps/web/src/app/tokens.css`. Kontras dihitung, bukan dinilai mata: `apps/web/test/contrast.unit.test.ts` (formula WCAG) dan diverifikasi ulang dengan `contrast-check.py` dari skill antislop-human (hasil di `docs/HASIL-FRONTEND.md`).

| Token | Terang | Gelap | Fungsi dan alasan |
|---|---|---|---|
| bg | #f3f0e8 | #11100e | Dasar hangat bernuansa kertas dan grafit. Hangat dipilih agar gambar kamera yang dingin terbaca sebagai fokus. |
| surface | #fbfaf6 | #1a1915 | Panel. Satu tingkat di atas bg. |
| raised | #ffffff | #24221c | Dialog dan bingkai media. Satu-satunya tingkat yang mendapat bayangan. |
| text | #1b1913 | #efeadf | Teks utama. |
| muted | #5a5446 | #b7af9e | Teks sekunder, lulus 4.5:1 pada semua permukaan. |
| line | #8c8573 | #7d7766 | Batas kontrol dan tanda potong, minimal 3:1. |
| line-soft | #d6d0c1 | #3a372f | Pemisah dekoratif saja. Tidak dipakai untuk batas kontrol. |
| accent | #f2b13c | #f2b13c | Satu aksen: tombol utama dan pilihan aktif. Seperti lampu tally. Teks di atasnya memakai on-accent. |
| accent-text | #7a4f00 | #f2b13c | Aksen sebagai teks atau cincin fokus. |
| danger | #a8321f | #ff9b8a | Galat. Selalu disertai teks dan ikon. |
| ok | #1f6b3a | #8ed9a2 | Hasil terbukti. Selalu disertai teks dan ikon. |

Inti: dua keluarga netral (kertas, grafit) dan satu aksen. Merah dan hijau adalah penanda status fungsional, tidak pernah berdiri sendiri (R-29).

Tema: terang dan gelap, keduanya diuji. Bawaan mengikuti sistem operasi. Tombol tema menyimpan pilihan di localStorage (hanya preferensi tampilan). Alasan gelap sah: ruang kendali redup dan gambar kamera lebih nyaman dilihat di latar gelap. Alasan terang sah: kantor lokasi siang hari.

## Tipografi

- UI dan judul: Atkinson Hyperlegible Next (self-host lewat @fontsource, OFL). Dirancang agar karakter mirip (0/O, 1/l/I) mudah dibedakan. Operator membaca id perangkat, firmware, dan alamat. Bukan font bawaan model (R-06).
- Data teknis: Atkinson Hyperlegible Mono, hanya untuk id, token kanal, alamat, dan waktu. Bukan untuk judul.
- Wordmark: teks PANTAU, berat 800, jarak huruf 0.08em. Tanpa logo, tanpa ikon, sesuai instruksi.
- Skala: 15 px dasar padat, 17 px untuk isi, judul 22 dan 30 px dengan `clamp()`. Tidak ada teks kapital berjarak lebar sebagai label.

## Tata letak

Tiga keadaan menurut lebar konten, bukan daftar perangkat:

1. Di bawah 720 px: satu layar per keputusan. Daftar perangkat, lalu layar detail dengan bilah aksi di bawah yang menyisakan ruang (padding aman). Navigasi berlabel "Menu", bukan hamburger polos.
2. 720 sampai 1199 px: dua zona. Daftar di kiri, meja snapshot di kanan, lembar probe di bawah snapshot.
3. 1200 px ke atas: tiga zona. Daftar, meja snapshot (fokus, paling lebar), lembar probe.

Elemen sengaja berbeda ukuran menurut hierarki: bingkai snapshot dominan, slot kamera lebih kecil, lembar probe berupa tabel dua kolom, bukan kartu seragam.

## Label yang jujur

- "Probe terakhir" berarti probe saat perangkat ditambahkan (API tidak menyediakan probe ulang). Tampil bersama tanggal dan catatan: hasil itu bukan status perangkat sekarang. Kata "online" tidak dipakai.
- Kemampuan memakai tiga kata dari API: Terbukti saat probe, Tidak tersedia, Belum diuji. Selalu dengan glif dan teks.
- Snapshot adalah satu gambar, bukan video langsung. Waktu yang ditampilkan adalah waktu gambar diterima di browser, karena respons tidak membawa waktu tangkap dari perangkat.
- Mode demo diberi label "Simulasi" yang tidak bisa dilewatkan di setiap layar. Gambar dari fixture diberi tulisan SIMULASI di dalam gambar.

## Status layar

Setiap tampilan data punya: memuat (dengan teks), kosong (sebab dan langkah berikutnya), galat (apa yang gagal dan apa yang bisa dilakukan), dilarang (403), sesi berakhir (401), dan hasil saring kosong. Status tidak mengandalkan warna.

## Yang ditolak

Sidebar dengan empat kartu statistik, grafik tanpa pertanyaan, umpan aktivitas, gradien ungu atau biru, kaca buram, glow, latar grid, lencana kapsul, titik status berdenyut, ikon pustaka seragam, bento, ilustrasi generik, angka dekoratif, emoji, status "live" palsu.

## Ikon

Enam glif gambar sendiri (cari, tutup, ulangi, layar penuh, unduh, peringatan) dengan sudut runcing dan goresan 2 px, ditambah tiga penanda status (terbukti, tidak ada, belum diuji) berbentuk berbeda: centang, silang, cincin putus-putus. Kegunaan tiap glif ditulis di `apps/web/src/components/glyphs.tsx`.

## Gerak

Dialog: fade 100 ms. Tombol: perubahan warna 100 ms. Tidak ada yang lain. Di bawah `prefers-reduced-motion: reduce` semua transisi dimatikan.

## Fixture gambar

Gambar demo dibuat oleh skrip repo (`scripts/make-demo-frames.mjs`), adegan abstrak buatan sendiri tanpa orang, dirender Chromium lalu disimpan sebagai JPEG. Tidak ada aset pihak ketiga. Setiap bingkai bertuliskan SIMULASI. Provenance: dibuat untuk repo ini, tanpa lisensi pihak ketiga.

## Catatan keputusan (R-31)

| Keputusan | Alasan satu baris |
|---|---|
| Snapshot sebagai fokus | Itulah keputusan operator di layar ini. |
| Aksen amber tunggal | Menandai satu tindakan utama dan pilihan aktif. |
| Warna hangat | Membuat gambar kamera menonjol. |
| Atkinson Hyperlegible | Id dan firmware harus terbaca tanpa salah karakter. |
| Tanda potong | Motif satu-satunya yang berulang, relevan dengan lembar kontak. |
| Tiga keadaan tata letak | Tablet dan laptop kecil tidak boleh jadi tumpukan ponsel yang melebar. |
| Native `<dialog>` | Jebakan fokus, Escape, dan pengembalian fokus sudah dibakukan browser. |
| Tanpa shadcn/ui | PRD menyebutnya, tetapi identitas buatan sendiri butuh komponen sendiri; dicatat di docs/DECISIONS.md D16. |
| Proxy same-origin | Cookie sesi dan pemeriksaan Origin backend tetap berlaku tanpa melonggarkan CSRF. |

## Tambahan gelombang 2 (halaman Keamanan, Akses, Agen)

- **Langkah 2FA di layar masuk**: bentuk dan komposisi sama dengan layar masuk; fokus pindah ke kolom kode saat langkah terbuka, dan ada jalan keluar eksplisit (kode cadangan, Kembali). Teks galat selalu tertulis.
- **Keamanan**: satu kolom, dua langkah bernomor. Kode QR digambar sebagai satu jalur SVG di atas latar putih (kontras pemindai terjaga di kedua tema) dengan tanda potong, dan kunci manual selalu ada untuk yang tidak bisa memindai. Kode cadangan tampil sekali, dan tombol konfirmasi baru aktif setelah ditandai tersimpan.
- **Akses**: dikelompokkan per lokasi, tiap kamera memuat siapa yang berhak dan izinnya (teks "Lihat" atau "Operasi", bukan warna). Bagi non-pemilik halaman yang sama menjadi tabel "Akses Anda" per kamera.
- **Agen**: satu kartu per agen dengan status bertulis (Terhubung, Tidak terhubung, Dicabut) beserta glif berbeda bentuk. "Terhubung" berarti soket aktif ke server ini, bukan kamera menyala; keterjangkauan kamera dilaporkan terpisah dan menyebut jam laporannya. Token pendaftaran tampil di dialog, sekali, dan lenyap dari halaman saat ditutup. Pencabutan selalu lewat dialog konfirmasi.
- **Bilah atas** boleh membungkus ke baris kedua; tidak ada tautan yang terpotong atau menggulir ke samping.
- **Tombol primer** tidak menganimasikan latar (hanya border), karena frame antara latar yang memudar di bawah teks yang berganti seketika berkontras 1,04:1.

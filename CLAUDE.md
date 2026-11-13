# CLAUDE.md: catatan sesi Don't Take My Seat

Dibaca otomatis di setiap sesi baru. **Isi file ini lebih baru daripada skill `dont-take-my-seat-dev`**. Kalau keduanya bertentangan, ikuti file ini dan `docs/ARCHITECTURE.md`.

Terakhir diperbarui: 11 November 2026, versi **0.21.1**, protokol **v13**.

## Pengguna

- Berbicara bahasa Indonesia; jawab dalam bahasa Indonesia.
- Tidak bisa compile di perangkatnya. Semua build, tes, dan deploy berjalan di cloud (GitHub Actions).
- Main di HP (Android dan iPhone/Safari), landscape.

## Yang berubah dibanding skill lama

| Skill lama | Sekarang |
|---|---|
| APK Capacitor + workflow Android | **APK dihapus.** Game adalah PWA (`vite-plugin-pwa`, `src/ui/pwa.ts`), dipasang dari browser. Workflow: CI, Security, Web (GitHub Pages), Worker (Cloudflare) |
| Signaling hanya MQTT | **Cloudflare Worker** (`worker/`, WebSocket `/room/<topik>`, Durable Object) + MQTT + Nostr bersamaan (`src/net/signal/roomSignaling.ts`, `relayLink.ts` menyambung ulang sendiri) |
| Belum ada TURN | **Cloudflare TURN** dari Worker `/turn` (`src/net/rtc/ice.ts`). URL Worker lewat variabel repo `SIGNAL_URL` → `VITE_SIGNAL_URL`, atau `?worker=URL` |
| Pemain terputus diganti bot | **Room tanpa bot.** Pemain terputus tetap diam ("Terputus") dan bisa **Gabung lagi** dengan `playerKey` (`src/net/playerKey.ts`). Min 2 pemain |
| `PROTOCOL_VERSION` 2 | **13** (`src/net/protocol.ts`) |
| Host keluar = room selesai | **Host pindah** ke pemain berikutnya dengan kode room yang sama (lihat ARCHITECTURE, *Keluar dan bergabung lagi*) |
| 3 challenge, 2 power-up | Lihat daftar di bawah |

## Gameplay saat ini (v0.21.0)

- Perjalanan nyata Commuter Line Bogor (+ cabang Nambo), 8 stasiun acak per game (`pickRoute`, `BOGOR_LINE`, `NAMBO_BRANCH` di `config.ts`).
- Kursi makin sedikit (`CONFIG.seats`): stop 1–2 lebih banyak dari pemain, stop 3–4 kurang satu, stop 5+ kurang dua, stasiun terakhir cuma 1 kursi.
- Tombol aksi kontekstual: DUDUK / TENDANG / DORONG.
- **NPC pemburu kursi**: 1–2 penumpang berdiri per stop (2–3 saat rush hour, tidak di stasiun terakhir) ikut berebut kursi; tiap pemburu menambah 1 kursi kosong; satu bisa lansia (ke kursi prioritas); bisa didorong (`Stander.hunt`, lihat ARCHITECTURE).
- **Challenge harian** (`CHALLENGE_KINDS`): `suddenBrake`, `crowd`, `oneSideDoors`, `kickFight` (tendang pemain yang duduk), `puddles` (lantai becek, terpeleset).
- **Event spesial**: `rushHour` (25% per stop selain pertama/terakhir, maks 2 per game, 22 penumpang berdiri, +4 detik); **kursi prioritas pindah** (30%, berkedip merah dulu, +3 detik).
- **Menendang penumpang NPC yang duduk**: pertama −20 poin, kedua kali petugas KRL membawamu keluar (gugur). Ada model petugas, animasi, peluit. **Kalau semua pemain dibawa petugas**: game langsung mulai lagi dari stasiun pertama (rute sama) dan tiap pemain −50 poin (`CONFIG.points.allCaught`, tidak di bawah 0).
- **Item di lantai, 1–3 per stop** (`POWER_UP_KINDS`): `earphones` (kebal dorong 4 dtk), `sleep` (aman sekali di kursi prioritas), `coffee` (es kopi, 1,4× cepat 5 dtk), `mbg` (ompreng MBG basi: hijau dan lambat 5 dtk, membatalkan kopi).
- **Poin**: +10 per stasiun duduk, +5 per tendangan, +50 menang. Game selesai saat tinggal 1 pemain → **popup juara** (daftar, Juara 1 paling atas dengan medali 🥇🥈🥉, tanpa podium; confetti) dengan tombol **Lanjutkan**/**Keluar**, tanpa timer (di room hanya host yang melanjutkan); poin terbawa.
- **Shop "TokopaEdi"** (tombol "Shop" berbentuk pil di **pojok kanan atas menu**, logo toko sendiri, tanpa promo, tanpa aksesoris gratis): **koin** dari main (terpisah dari poin), 24 **aksesoris** hiasan (topi, kaos, wajah, tas) dengan pratinjau 3D, **cincin identitas** warna pemain di bawah kaki, 5 **item** sekali pakai (ransel jumbo, dorongan bahu, sepatu lari, taruh tas di kursi, permen jahe), **bawa 1 per game**, pengaturan host "Item toko di room-ku". Lihat ARCHITECTURE, *Shop*.
- **Papan peringkat** lewat Worker `/scores` (`src/net/leaderboard.ts`).
- **Host keluar → pemain berikutnya jadi host** (notifikasi 👑, kode sama, poin terbawa). HP host mati → pengganti ambil alih setelah 8 dtk. **Gabung lagi** ke room kosong → dibuka lagi sebagai host (10 dtk).
- Karakter chibi bulat, animasi tendang, bintang pusing. **Tips nyala secara default, tiap tips sekali di awal** (`settings.tipsDone`; pengaturan Tips Nyala/Mati dan tombol Tampilkan tips lagi).
- Anti-zoom iPhone Safari (`src/ui/noZoom.ts`, lihat ARCHITECTURE): jangan hapus `touch-action: pan-y` di panel scroll, dan kolom teks baru minimal 16 px. Pengaturan kontrol lengkap (ukuran tombol, posisi analog, getar). Indikator ping, panel `?debug`.
- Host tetap berjalan saat di latar belakang (timer Web Worker) dan mengejar waktu di perangkat lambat (maks 0,25 dtk per frame).

## Aturan yang tetap berlaku

1. `src/core` dan `src/ai` murni (tanpa Three.js/DOM/input/audio). Game = `step(state, inputs, dt)`.
2. Acak hanya lewat RNG ber-seed di `GameState`. Tanpa `Math.random` di core.
3. Host penentu; client kirim input, terima snapshot. Render hanya membaca state.
4. Data dari luar selalu divalidasi.
5. Angka gameplay di `CONFIG`.
6. Teks baru di `en.ts` **dan** `id.ts` (kunci dan placeholder sama).
7. State baru yang perlu terlihat client → naikkan `PROTOCOL_VERSION`, perbarui pack/apply/validator dan tes round-trip di `tests/net.test.ts`.
8. Hindari logo/corak resmi KAI Commuter; nama stasiun boleh.

## Verifikasi dan rilis

```bash
npm run check && npm run build && npm audit --omit=dev --audit-level=high
```

Cek browser dengan Playwright sesuai skill (viewport 844×390, `?signal=local` untuk multiplayer, `?mock=messenger&user=u1`). Rilis: `npm version X.Y.Z --no-git-tag-version`, commit, push ke `main`, pantau `gh run list` (CI + Web). Worker hanya di-deploy lewat workflow **Worker (Cloudflare)** kalau `worker/` berubah; domain baru → `ALLOWED_ORIGINS` di `worker/wrangler.toml`.

## Pekerjaan terbuka

- PR Dependabot (bump typescript, vite, vitest) **gagal di CI dan Security** per 10 Nov; perlu dicek dan diperbaiki atau ditutup.
- Integrasi chat app pengguna (Kotlin + Capacitor/Ionic) masih menunggu akses kodenya; SDK siap di `messenger-sdk/`. Repo `whiskey34/chat-app` BUKAN chat app itu.
- Host pindah: game yang sedang berjalan belum dilanjutkan di host baru (semua kembali ke lobby). Bisa dikembangkan dengan mengirim state lengkap ke pengganti.
- Lag P2P: usulan bertahap: (1) ukur di `?debug` (ukuran snapshot, upload host, TURN atau tidak), (2) snapshot biner + delta, (3) server game di Durable Object (simulasi `src/core` di server, P2P tetap sebagai cadangan). Menunggu keputusan pengguna.
- Shop: penyimpanan koin/barang masih di localStorage (bisa diakali, hilang kalau cache dihapus); pindah ke server bersamaan dengan server game.
- Ide yang belum dibuat: mode QR tanpa internet, gabung otomatis dari tautan `?join=KODE`, kursi palsu (tas), kursi diumumkan telat, Manggarai chaos.
- Keseimbangan: rata-rata game ~25–30 detik, bot jangan terlalu cepat. Setelah ubah gameplay, jalankan simulasi 200 game bot (selalu satu pemenang, tanpa kursi ganda).

## Riwayat singkat

- s.d. 3 Nov: gameplay inti, multiplayer WebRTC + MQTT, SDK messenger, challenge & power-up awal.
- 9 Nov: jadi PWA, APK dihapus, relay Nostr, TURN.
- 10 Nov (v0.8–v0.14): Worker + TURN, gabung lagi, perbaikan pemain tersangkut, stasiun Bogor asli, adu tendang, lantai becek, poin, kursi makin sedikit, es kopi, tips, karakter chibi, papan peringkat, rush hour, kursi prioritas pindah, petugas.
- 11 Nov (v0.15.0): rush hour lebih padat, ompreng MBG basi, 1–3 item acak per stop.
- 11 Nov (v0.16.0): perbaikan zoom di Safari iPhone, tips wajib muncul secara default (bisa dimatikan).
- 11 Nov (v0.17.0): host pindah otomatis ke pemain berikutnya, room kosong bisa dibuka lagi lewat Gabung lagi, tips kembali sekali di awal (tetap default nyala).
- 11 Nov (v0.18.0): popup juara dengan confetti, tombol Lanjutkan tanpa hitung mundur otomatis.
- 11 Nov (v0.18.1): podium diganti daftar (Juara 1 paling atas).
- 13 Nov (v0.21.1): tombol Shop dipindah ke pojok kanan atas menu.
- 12 Nov (v0.21.0): shop TokopaEdi: koin, aksesoris, cincin identitas, 5 item gameplay (bawa 1 per game), opsi room tanpa item.
- 12 Nov (v0.20.0): NPC berdiri ikut berebut kursi (opsi A: tiap pemburu menambah 1 kursi), lansia ke kursi prioritas, bisa didorong.
- 11 Nov (v0.19.0): semua pemain tertangkap petugas → tidak freeze lagi, game mulai dari awal dengan −50 poin. (Dibahas juga: server game di Durable Object untuk mengurangi lag P2P; belum dikerjakan, menunggu keputusan pengguna soal jumlah pemain dan paket berbayar Cloudflare.)

Saat sesi selesai, perbarui bagian **Gameplay saat ini**, **Pekerjaan terbuka**, dan **Riwayat singkat** di file ini.

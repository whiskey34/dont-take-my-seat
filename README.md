# Don't Take My Seat

Mini game *musical chairs* di kereta komuter. Empat penumpang, kursi selalu kurang satu, dan yang tidak dapat kursi saat pintu tertutup akan gugur.

- **Platform:** web app (PWA). Dimainkan langsung di browser, bisa dipasang ke layar utama HP, dan bisa dimuat di dalam chat app sebagai mini game.
- **Main:** https://whiskey34.github.io/dont-take-my-seat/
- **Teknologi:** TypeScript, Three.js (semi 3D low-poly), Vite, Vitest.
- **Bahasa:** English dan Indonesia (otomatis mengikuti bahasa perangkat).

## Mode bermain

| Mode | Cara |
|---|---|
| **Lawan bot** | Offline, 1 pemain + 3 bot |
| **Buat room / Gabung room** | Sampai 4 HP lewat WebRTC P2P. Host membagikan kode 5 karakter; main 2–4 orang tanpa bot (tempat kosong dibiarkan kosong). Pemain yang keluar di tengah game bisa **Gabung lagi** dari menu dan melanjutkan dengan karakternya sendiri |
| **Di dalam chat app** | Dibuka dari kartu undangan di chat; data lewat koneksi P2P chat. Pasang modul [messenger-sdk/](messenger-sdk/README.md) di chat app (Ionic/Capacitor). Coba [chat demo](https://whiskey34.github.io/dont-take-my-seat/messenger-sdk/demo/index.html), lalu buka tautan teman yang tampil di HP lain |

Supaya HP di operator yang memblokir koneksi langsung (Indosat, XL, Biznet, …) tetap bisa main, pasang **Cloudflare Worker + TURN** sekali: ikuti [worker/README.md](worker/README.md).

Detail teknis ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Cara main

- Gerak: joystick di sisi kiri layar (atau WASD / panah).
- Aksi: tombol kanan. Berubah jadi **DUDUK** di dekat kursi kosong, **TENDANG** saat adu tendang, selain itu **DORONG**.
- Kursi merah adalah kursi prioritas: kalau diduduki, kamu akan diminta berdiri.
- **Challenge acak di setiap stasiun**, diumumkan di papan stasiun:
  - **Rem mendadak:** kereta tersentak sekali; siapa pun yang sedang diam akan oleng.
  - **Penumpang berdiri:** penumpang di lorong menghalangi jalan dan sesekali bergeser.
  - **Pintu satu sisi:** hanya pintu kiri atau kanan yang terbuka, dan penumpang baru masuk lalu berdiri di lorong sisi itu.
  - **Adu tendang:** berdiri di depan pemain yang duduk lalu tekan **TENDANG** untuk menendangnya dari kursi (earphone menahan tendangan). Waktu rebutan berjalan penuh karena kursi bisa berpindah tangan.
  - **Lantai becek:** genangan air di lantai; lari ke genangan dan kamu terpeleset, terlempar cukup jauh dan tidak bisa dikendalikan sebentar. Jalan pelan aman.
- **Poin:** +10 setiap stasiun kamu tetap duduk, +5 setiap tendangan, +50 kalau menang. Game selesai saat tinggal satu pemain: muncul daftar juara (🥇 Juara 1 paling atas, lalu 🥈, 🥉, dan posisi lainnya) dengan confetti. Tekan **Lanjutkan** untuk game berikutnya (poin terus bertambah) atau **Keluar**; tidak ada hitung mundur. Di room, host yang menekan Lanjutkan untuk semua pemain.

**Shop (TokopaEdi):** kumpulkan koin dari setiap game (1 koin per 5 poin + bonus juara 1–3). Beli aksesoris untuk gaya (topi, kaos, masker/kacamata, tas) dan item sekali pakai: Tas Ransel Jumbo, Dorongan Bahu, Sepatu Lari, Taruh Tas di Kursi, Permen Jahe. Bawa 1 item per game, pakai dengan tombol item (atau E). Host room bisa mematikan item toko di Pengaturan.
- **Power-up di lantai** (satu per stasiun, ambil dengan berjalan di atasnya):
  - 🎧 **Earphone:** kebal dorongan selama 4 detik.
  - 💤 **Pura-pura tidur:** sekali duduk di kursi prioritas tanpa disuruh berdiri.
  - 🧋 **Es kopi:** lari lebih cepat selama 5 detik.
- **Kursi makin sedikit:** di stasiun-stasiun awal kursinya lebih banyak dari jumlah pemain, lalu makin jauh makin sedikit, dan di stasiun terakhir perjalanan cuma ada 1 kursi.
- Sensitivitas stik, nama, bahasa, dan suara bisa diatur di **Pengaturan** (juga dari menu jeda).

## Memasang di HP

- **Android (Chrome):** buka alamat game, lalu tekan **Pasang aplikasi** di menu (atau menu ⋮ → *Instal aplikasi*). Game muncul di layar utama dan terbuka layar penuh, landscape.
- **iPhone (Safari):** ketuk **Bagikan**, lalu **Tambahkan ke Layar Utama**. Safari tidak bisa mengunci orientasi, jadi miringkan HP sendiri.

Setelah dibuka sekali, mode **lawan bot bisa dimainkan tanpa internet**. Mode room tetap butuh internet untuk mencari pemain.

## Update

Setiap perubahan di branch `main` otomatis dicek, di-build, lalu diterbitkan ke GitHub Pages. Tidak perlu meng-compile apa pun atau memasang ulang. Versi baru diunduh di latar belakang dan diterapkan saat pemain kembali ke menu, tidak pernah di tengah permainan.

## Pengembangan

```bash
npm install
npm run dev      # buka alamat yang muncul, bisa juga dari HP di Wi-Fi yang sama
npm run check    # lint + typecheck + tes
npm run build    # hasil di dist/
```

## Struktur

```
src/
  core/     aturan game murni (tanpa tampilan) — bisa dites & dijalankan host
  ai/       perilaku bot
  session/  sesi offline, host, client (interpolasi & prediksi gerak)
  net/      protokol, lobby, WebRTC, signaling kode room, adaptor messenger
  render/   tampilan 3D (Three.js)
  input/    joystick, tombol, keyboard
  ui/       HUD, menu, pengaturan, gaya
  i18n/     teks EN & ID
  audio/    efek suara sintetis (tanpa file audio)
tests/      tes logika game, termasuk simulasi ratusan game antar bot
worker/     Cloudflare Worker: kode room lewat WebSocket (port 443) + kredensial TURN
messenger-sdk/  modul untuk chat app: iframe game, kanal game di WebRTC, undangan, chat demo
docs/       arsitektur & rencana multiplayer
```

## Lisensi

MIT

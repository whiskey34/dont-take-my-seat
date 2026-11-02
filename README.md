# Don't Take My Seat

Mini game *musical chairs* di kereta komuter. Empat penumpang, kursi selalu kurang satu, dan yang tidak dapat kursi saat pintu tertutup akan gugur.

- **Platform:** web (HTML5), dibungkus jadi APK Android dengan Capacitor, dan nantinya dimuat di dalam messenger P2P sebagai mini game.
- **Teknologi:** TypeScript, Three.js (semi 3D low-poly), Vite, Vitest.
- **Bahasa:** English dan Indonesia (otomatis mengikuti bahasa perangkat).

## Mode bermain

| Mode | Cara |
|---|---|
| **Lawan bot** | Offline, 1 pemain + 3 bot |
| **Buat room / Gabung room** | Sampai 4 HP lewat WebRTC P2P. Host membagikan kode 5 karakter; tempat kosong diisi bot |
| **Di dalam messenger** | Dibuka dari chat; pemain dan host ditentukan oleh chat. Lihat [docs/MESSENGER_SDK.md](docs/MESSENGER_SDK.md) |

Detail teknis ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Cara main

- Gerak: joystick di sisi kiri layar (atau WASD / panah).
- Aksi: tombol kanan. Berubah jadi **DUDUK** di dekat kursi kosong, selain itu **DORONG**.
- Kursi merah adalah kursi prioritas: kalau diduduki, kamu akan diminta berdiri.
- Sensitivitas stik, nama, bahasa, dan suara bisa diatur di **Pengaturan** (juga dari menu jeda).

## Hasil build otomatis

| Apa | Di mana |
|---|---|
| Versi web (untuk messenger & PWA) | GitHub Pages repo ini |
| APK Android | Release **apk-latest** di halaman Releases |

Keduanya dibuat ulang otomatis setiap ada perubahan di branch `main`. Tidak perlu meng-compile apa pun di perangkat sendiri.

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
scripts/    penyesuaian proyek Android (landscape, layar penuh)
docs/       arsitektur & rencana multiplayer
```

## Lisensi

MIT

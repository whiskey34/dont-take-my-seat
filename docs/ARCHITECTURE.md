# Arsitektur

## Prinsip

1. **Aturan game murni.** `src/core` tidak boleh mengimpor Three.js, DOM, input, atau audio (dijaga oleh ESLint). Seluruh game adalah fungsi `step(state, inputs, dt)`.
2. **Deterministik.** Acak memakai RNG ber-seed yang disimpan di `GameState`. Seed + urutan input yang sama menghasilkan game yang sama.
3. **Tampilan hanya membaca.** `render/` dan `ui/` membaca `GameState` dan `GameEvent`, tidak pernah mengubahnya.
4. **Input divalidasi.** Nilai input yang tidak valid (NaN, di luar rentang) diabaikan, tidak membuat game crash.

## Alur satu ronde

```
intro → riding (kereta jalan, goyang, lalu mengerem)
      → scramble (pintu terbuka, kursi kosong = pemain hidup − 1, plus 1 kursi prioritas jebakan)
      → result (yang berdiri gugur; kalau tidak ada yang duduk, stasiun diulang)
      → riding ... → gameOver (sisa 1 pemain)
```

## Rencana multiplayer (tahap berikutnya)

- **Host = penentu.** Host menjalankan `step()`; pemain lain hanya mengirim `PlayerInput` dan menerima snapshot `GameState` + event.
- **Adaptor jaringan** dengan satu antarmuka:
  - `messenger` — memakai DataChannel dari messenger lewat Mini Game SDK (bridge JavaScript di WebView).
  - `standalone` — WebRTC sendiri, signaling lewat QR / kode room.
  - `local` — bot dan pemain di satu perangkat (sekarang).
- **Protokol pesan** berversi dan divalidasi; dua channel: *unreliable* untuk input/snapshot, *reliable* untuk event.

## Integrasi messenger

Messenger memuat versi web dari GitHub Pages (atau bundel lokal) di WebView, lalu menyediakan bridge: info pengguna, info sesi & peserta, kirim/terima data, event lifecycle, dan kirim hasil ke chat.

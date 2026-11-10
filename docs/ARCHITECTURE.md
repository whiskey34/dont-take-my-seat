# Arsitektur

## Prinsip

1. **Aturan game murni.** `src/core` tidak boleh mengimpor Three.js, DOM, input, atau audio (dijaga oleh ESLint). Seluruh game adalah fungsi `step(state, inputs, dt)`.
2. **Deterministik.** Acak memakai RNG ber-seed yang disimpan di `GameState`.
3. **Host sebagai penentu.** Hanya host yang menjalankan `step()`. Pemain lain mengirim input dan menerima snapshot.
4. **Tampilan hanya membaca.** `render/` dan `ui/` membaca `GameState` dan `GameEvent`, tidak pernah mengubahnya.
5. **Semua data dari luar divalidasi.** Pesan jaringan yang rusak atau aneh diabaikan, tidak membuat game crash.

## Lapisan

```
ui / render / input / audio      tampilan & kontrol
        │
session/   GameSession            LocalSession · HostSession · ClientSession
        │
net/       HostNet · ClientNet    lobby, protokol berversi (protocol.ts)
        │
           Transport              satu antarmuka untuk semua jalur koneksi
   ┌────────────┼────────────────────────┐
RtcHost/JoinTransport          MessengerTransport
 (WebRTC, 2 DataChannel)        (Mini Game SDK di WebView)
        │
   Signaling: MqttSignaling (kode room, broker publik, terenkripsi)
              LocalSignaling (antar tab, untuk tes)
```

## Gerakan halus

- **Offline dan host:** simulasi berjalan tetap 60 kali per detik, lalu posisi di-interpolasi di antara dua tick sesuai refresh rate layar.
- **Pemain (client):**
  - Gerakan sendiri **diprediksi** langsung di HP, lalu dikoreksi perlahan ke posisi dari host. Koreksi menjadi cepat saat terkena dorongan, dan langsung lompat kalau selisihnya lebih dari 1,5 m.
  - Pemain lain digambar **120 ms di belakang** dan di-interpolasi di antara snapshot, sehingga tetap halus meskipun ada paket yang hilang.
- Snapshot dikirim 20 kali per detik lewat channel `fast` (boleh hilang); event dan aksi lewat `reliable`.

## Kode room (tanpa server sendiri)

1. Host membuat kode 5 karakter. Topik dan kunci AES-GCM diturunkan dari kode itu, sehingga relay tidak bisa membaca isinya.
2. Pemain mengirim `hello` ke topik tersebut berulang kali. Host membalas dengan offer WebRTC (kandidat ICE dikumpulkan di awal), lalu pemain membalas answer.
3. Setelah DataChannel terbuka, pemain berhenti memakai relay.

**Relay yang dipakai bersamaan** (`src/net/signal/roomSignaling.ts`), semuanya dicek langsung di CI (job `brokers`):
- MQTT: `broker.emqx.io:8084`, `broker.hivemq.com:8884`.
- Nostr (port 443, untuk jaringan yang memblokir port MQTT): `relay.damus.io`, `relay.primal.net`, `relay.snort.social`, `offchain.pub`. Yang pernah dicoba tapi tidak meneruskan event: `nos.lol`, `nostr.mom`, `relay.nostr.band`.

**Tahan putus** (`src/net/signal/relayLink.ts`): setiap koneksi relay menyambung ulang sendiri dengan jeda bertahap, dan langsung saat halaman tampil lagi atau internet kembali. Ini penting karena HP host biasanya memutus koneksi saat host pindah ke WhatsApp untuk membagikan kode. Lobby host menampilkan peringatan selama room tidak bisa dijangkau.

**Alur bergabung** (`RtcJoinTransport`): tahap *mencari room* → *room ditemukan, menyambungkan* → (bila koneksi langsung gagal atau macet 15 detik) *mencoba lagi* dengan id baru. Batas total 60 detik, lalu pesan berbeda untuk "room tidak ditemukan" dan "room ditemukan tapi HP tidak bisa tersambung langsung".

**Keterbatasan:** belum ada server TURN. Lima server TURN gratis tanpa pendaftaran (openrelay.metered.ca, freestun.net) diuji dari browser di CI (job `turn`) dan semuanya gagal. Jadi HP di jaringan yang sangat ketat (sebagian CGNAT seluler, Wi-Fi dengan isolasi klien) mungkin tidak bisa tersambung langsung. Solusinya TURN dengan akun gratis (Metered, Cloudflare Calls), yang belum dipasang.

## Keluar dan bergabung lagi

- Setiap perangkat punya **kunci pemain** acak yang disimpan di pengaturan (`playerKey`) dan dikirim di pesan `hello` (protokol **v3**). Tab kedua di browser yang sama mendapat kuncinya sendiri lewat Web Lock (`src/net/playerKey.ts`). Di dalam chat app, kuncinya diturunkan dari ID pengguna chat.
- Host menyimpan tiap pemain sebagai *member*: id pemain (tetap selama game), kunci, dan koneksi saat ini. Kalau koneksi putus atau pemain kembali ke menu **saat game berjalan**, tempatnya disimpan: karakternya diam di tempat (tidak dikendalikan bot) dan tampil "Terputus" (daftar `off` di snapshot). Game tidak dijeda.
- Saat perangkat dengan kunci yang sama menyapa lagi, host menyambungkannya ke id pemain lamanya, lalu mengirim ulang `welcome` dan `start` plus snapshot terbaru, sehingga pemain melanjutkan di posisi dan kondisi saat itu. Orang asing tetap ditolak (`started`) selama game berjalan.
- Menu menampilkan tombol **Gabung lagi ke room KODE** selama 30 menit setelah bergabung dengan kode room. Tombol ini hilang kalau room ditutup atau menolak.
- Pemain yang sudah keluar saat host memulai game berikutnya tidak diikutkan; tempatnya diisi bot.
- Host tidak bisa digantikan: kalau host keluar, room berakhir untuk semua pemain.

## Alur satu ronde

```
intro → riding (kereta jalan, goyang, lalu mengerem)
      → scramble (kursi kosong = pemain hidup − 1, plus 1 kursi prioritas jebakan)
      → result (yang berdiri gugur; kalau tidak ada yang duduk, stasiun diulang)
      → riding ... → gameOver
```

## Challenge dan power-up

- Logikanya ada di `src/core/challenges.ts`, dan angkanya (kekuatan rem, jumlah penumpang, durasi earphone) di `CONFIG.challenge` dan `CONFIG.powerUp`.
- Challenge dipilih acak (RNG ber-seed) saat kereta berangkat dari setiap stasiun, jadi host dan replay selalu konsisten.
- Snapshot multiplayer (protokol **v2**) membawa challenge, waktu rem, sisi pintu, posisi penumpang berdiri, power-up, serta status earphone dan pura-pura tidur tiap pemain. Pemain dengan versi game berbeda akan ditolak dengan pesan jelas.

## Web app (PWA)

- `vite-plugin-pwa` membuat `manifest.webmanifest` (layar penuh, landscape, ikon 192/512/maskable) dan `sw.js` (Workbox) yang menyimpan semua file game untuk offline, termasuk chat demo. Konfigurasinya di `vite.config.ts`.
- `ignoreURLParametersMatching: [/.*/]` membuat tautan dengan parameter (`?embed=messenger`, `?room=`, `?signal=`) tetap terbuka dari cache.
- `src/ui/pwa.ts` mendaftarkan service worker sendiri (tanpa `virtual:pwa-register`). Versi baru menunggu (`waiting`) dan hanya diaktifkan lewat pesan `SKIP_WAITING` saat game di menu utama tanpa koneksi multiplayer, lalu halaman di-reload sekali.
- Di dalam iframe chat app (`?embed=messenger`) service worker tidak didaftarkan; caching diurus oleh chat app.
- Ikon PNG di `public/` dibuat dari `public/icon.svg`. Kalau ikon diubah, render ulang ke `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (gambar di zona aman 80%), dan `apple-touch-icon.png` (180 px, latar penuh).

## Parameter URL untuk pengembangan

| Parameter | Fungsi |
|---|---|
| `?signal=local` | Kode room lewat antar tab (tanpa internet), untuk tes WebRTC di satu browser |
| `?mock=messenger&user=u1` | Messenger tiruan (`u1` = host, `u2`–`u4` = peserta) |

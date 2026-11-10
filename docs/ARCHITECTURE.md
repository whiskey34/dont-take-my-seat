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
   Signaling: RoomSignaling (kode room, terenkripsi): Cloudflare Worker
              + MQTT + Nostr bersamaan · LocalSignaling (antar tab, untuk tes)
   ICE:       Cloudflare TURN dari Worker (/turn), cadangan STUN publik
```

## Gerakan halus

- **Offline dan host:** simulasi berjalan tetap 60 kali per detik, lalu posisi di-interpolasi di antara dua tick sesuai refresh rate layar.
- **Pemain (client):**
  - Gerakan sendiri **diprediksi** langsung di HP. Input gerak dikirim ±60 kali per detik dengan nomor urut; snapshot dari host membawa nomor input terakhir yang sudah dipakai host (`ack`, protokol **v4**). Setiap snapshot, HP mulai dari posisi host lalu memutar ulang input yang belum sampai ke host (*reconciliation*). Selisih kecil disembunyikan dengan offset visual yang memudar cepat; selisih lebih dari 1,5 m (didorong, duduk) langsung ditampilkan.
  - Sebelumnya HP hanya ditarik perlahan ke posisi host. Dengan latensi nyata (mis. Safari lewat Wi-Fi/seluler) tarikan itu memperlambat gerakan sampai ±40% sehingga kontrol terasa kaku; tes `keeps a remote player responsive under 100 ms latency` menjaga ini.
  - Pemain lain digambar **120 ms di belakang** dan di-interpolasi di antara snapshot, sehingga tetap halus meskipun ada paket yang hilang.
- Snapshot dikirim 20 kali per detik lewat channel `fast` (boleh hilang); event dan aksi lewat `reliable`.

**Penyebab pemain "tersangkut" yang sudah ditangani:**
- *Host di latar belakang* (layar redup, pindah ke WhatsApp): browser menghentikan `requestAnimationFrame`, sehingga game di host berhenti dan semua pemain lain membeku. Sekarang timer di Web Worker tetap menjalankan game host (±30 kali per detik) selama halaman tersembunyi.
- *Joystick macet*: kalau browser (terutama iOS) kehilangan event "jari diangkat", sentuhan baru dulu diabaikan. Sekarang sentuhan baru selalu mengambil alih stik, dan jari yang sedang dipakai di-*capture* (`setPointerCapture`).
- *Lantai becek*: dari posisi diam, pemain tetap bisa mulai berjalan (licin hanya untuk berhenti dan berbelok).
- *Latensi tinggi*: riwayat input yang diputar ulang diperpanjang menjadi 4 detik, dan pemain melihat tanda *Sinyal lemah…* kalau snapshot dari host berhenti lebih dari 0,6 detik.

## Kode room (tanpa server sendiri)

1. Host membuat kode 5 karakter. Topik dan kunci AES-GCM diturunkan dari kode itu, sehingga relay tidak bisa membaca isinya.
2. Pemain mengirim `hello` ke topik tersebut berulang kali. Host membalas dengan offer WebRTC (kandidat ICE dikumpulkan di awal), lalu pemain membalas answer.
3. Setelah DataChannel terbuka, pemain berhenti memakai relay.

**Relay yang dipakai bersamaan** (`src/net/signal/roomSignaling.ts`):
- **Cloudflare Worker** (jalur utama bila `VITE_SIGNAL_URL` diisi saat build, atau `?worker=URL`): WebSocket di port 443 ke `/room/<topik>`, satu Durable Object per room. Kode dan cara pasang di `worker/` (lihat `worker/README.md`).
- MQTT: `broker.emqx.io:8084`, `broker.hivemq.com:8884`.
- Nostr (port 443, untuk jaringan yang memblokir port MQTT): `relay.damus.io`, `relay.primal.net`, `relay.snort.social`, `offchain.pub`. Yang pernah dicoba tapi tidak meneruskan event: `nos.lol`, `nostr.mom`, `relay.nostr.band`.

**Tahan putus** (`src/net/signal/relayLink.ts`): setiap koneksi relay menyambung ulang sendiri dengan jeda bertahap, dan langsung saat halaman tampil lagi atau internet kembali. Ini penting karena HP host biasanya memutus koneksi saat host pindah ke WhatsApp untuk membagikan kode. Lobby host menampilkan peringatan selama room tidak bisa dijangkau.

**Alur bergabung** (`RtcJoinTransport`): tahap *mencari room* → *room ditemukan, menyambungkan* → (bila koneksi langsung gagal atau macet 15 detik) *mencoba lagi* dengan id baru. Batas total 60 detik, lalu pesan berbeda untuk "room tidak ditemukan" dan "room ditemukan tapi HP tidak bisa tersambung langsung".

**TURN** (`src/net/rtc/ice.ts`): saat membuat atau bergabung ke room, game mengambil kredensial Cloudflare TURN dari Worker (`/turn`, berlaku 4 jam). TURN berjalan di port 443 dan 80 (TCP/TLS juga), sehingga HP di operator yang memblokir koneksi langsung (Indosat, XL, Biznet, CGNAT, Wi-Fi dengan isolasi klien) tetap tersambung lewat relay Cloudflare. Pengumpulan kandidat ICE menunggu sampai 5 detik bila TURN aktif, dan selesai 0,7 detik setelah kandidat relay pertama muncul. Tanpa Worker, hanya STUN publik (server TURN gratis tanpa daftar sudah diuji di CI dan semuanya gagal).

**Tes 4 pemain:** 4 browser terpisah, relay publik diblokir, hanya lewat Worker lokal: keempat pemain masuk lobby dalam ±4 detik dan bermain bersama.

## Keluar dan bergabung lagi

- Setiap perangkat punya **kunci pemain** acak yang disimpan di pengaturan (`playerKey`) dan dikirim di pesan `hello` (sejak protokol **v3**). Tab kedua di browser yang sama mendapat kuncinya sendiri lewat Web Lock (`src/net/playerKey.ts`). Di dalam chat app, kuncinya diturunkan dari ID pengguna chat.
- Host menyimpan tiap pemain sebagai *member*: id pemain (tetap selama game), kunci, dan koneksi saat ini. Kalau koneksi putus atau pemain kembali ke menu **saat game berjalan**, tempatnya disimpan: karakternya diam di tempat (tidak dikendalikan bot) dan tampil "Terputus" (daftar `off` di snapshot). Game tidak dijeda.
- Saat perangkat dengan kunci yang sama menyapa lagi, host menyambungkannya ke id pemain lamanya, lalu mengirim ulang `welcome` dan `start` plus snapshot terbaru, sehingga pemain melanjutkan di posisi dan kondisi saat itu. Orang asing tetap ditolak (`started`) selama game berjalan.
- **Sinyal terganggu** (`ClientNet`): koneksi yang putus tanpa pesan `bye` dari host, atau tidak ada data dari host selama 4 detik saat game berjalan, dilaporkan sebagai `lost` (bukan "host keluar"). Pemain tetap di layar game dengan tanda *Sinyal terganggu, menyambung ulang…*, lalu otomatis bergabung lagi dengan kunci yang sama, dan host mengembalikannya ke karakternya di posisi saat ini. Tidak perlu penyimpanan di server: host sudah memegang seluruh state game. Kalau gagal dalam 60 detik, barulah kembali ke menu.
- Menu menampilkan tombol **Gabung lagi ke room KODE** selama 30 menit setelah bergabung dengan kode room. Tombol ini hilang kalau room ditutup atau menolak.
- Pemain yang sudah keluar saat host memulai game berikutnya tidak diikutkan. Room tidak memakai bot: minimal 2 pemain, tempat kosong dibiarkan kosong; kalau host tinggal sendiri setelah game, host kembali ke lobby.
- **Nomor input** (`ClientNet.inputSeq`) terus naik selama koneksi, tidak diulang dari 1 di setiap game. Dulu nomor diulang, sementara input terakhir dari game sebelumnya (bernomor tinggi) masih dalam perjalanan saat game baru dimulai; host lalu menganggap semua input baru "lama" dan mengabaikannya, sehingga pemain tersangkut di posisi awal (terlihat di panel debug sebagai `sent #266 ack #1678`). Sebagai pengaman, host juga mengikuti nomor yang tiba-tiba jauh lebih kecil (selisih lebih dari 600).
- Host tidak bisa digantikan: kalau host keluar, room berakhir untuk semua pemain.

## Alur satu ronde

```
intro → riding (kereta jalan, goyang, lalu mengerem)
      → scramble (kursi kosong = pemain hidup − 1, plus 1 kursi prioritas jebakan)
      → result (yang berdiri gugur; kalau tidak ada yang duduk, stasiun diulang)
      → riding ... → gameOver
```

## Stasiun

- Daftar stasiun ada di `src/core/config.ts`: `BOGOR_LINE` (Commuter Line Bogor dari Bogor sampai Jakarta Kota, 24 stasiun) dan `NAMBO_BRANCH` (Nambo, Cibinong, bergabung di Citayam). Stasiun yang di peta belum melayani penumpang (Gambir, Sukaresmi, Pondok Rajeg, Gunung Putri) tidak dipakai.
- Setiap game memilih satu perjalanan acak dari seed (`pickRoute`): 8 stasiun berurutan, ke arah Jakarta Kota atau ke arah Bogor, atau sesekali dari Nambo lewat Citayam. `route[0]` adalah stasiun keberangkatan (tampil saat intro), lalu setiap stop adalah stasiun berikutnya. Kalau stasiun diulang (tidak ada yang duduk), namanya tetap sama.

## Jumlah kursi per stasiun

`seatsThisStop()` (angkanya di `CONFIG.seats`): makin jauh perjalanan, makin sedikit kursi.
- Stop 1–2: kursi **lebih banyak** dari jumlah pemain (`earlyExtra`, +2; pemanasan, yang gagal duduk tetap gugur). Rebutan selesai lebih awal kalau semua pemain sudah duduk.
- Stop 3–4: kurang satu. Stop 5 dan seterusnya: kurang dua (minimal 1).
- Stasiun terakhir perjalanan (`isFinalStop`): hanya 1 kursi, jadi game selalu selesai di sana. Papan stasiun menulis "Stasiun terakhir: cuma 1 kursi!".

## Challenge dan power-up

- Logikanya ada di `src/core/challenges.ts`, dan angkanya (kekuatan rem, jumlah penumpang, durasi earphone) di `CONFIG.challenge` dan `CONFIG.powerUp`.
- Challenge dipilih acak (RNG ber-seed) saat kereta berangkat dari setiap stasiun, jadi host dan replay selalu konsisten.
- Challenge **adu tendang** (`kickFight`): tombol aksi menendang pemain yang duduk dari kursinya (`seatKickTarget`, jarak dari depan kursi), jeda 2 detik; ronde tidak berakhir lebih awal walau semua kursi terisi. Challenge **lantai becek** (`puddles`): 3 genangan. Pemain yang lari ke genangan (lebih cepat dari 1,2 m/s) **terpeleset**: meluncur ke arah larinya dengan kecepatan 8,5 m/s yang berkurang pelan, tidak bisa dikendalikan selama 0,8 detik (`slipUntil`), lalu aman 0,5 detik sebelum bisa terpeleset lagi. Jalan pelan di atas genangan aman. Prediksi client memakai fungsi `move()` yang sama.
- **Poin** (`Player.score`, angka di `CONFIG.points`): +10 per ronde tetap duduk, +5 per tendangan, +50 menang; setiap perubahan juga dikirim sebagai event `points`. Poin dibawa ke game berikutnya lewat `PlayerSetup.score` (pesan `start`). Layar game over menghitung mundur 8 detik lalu memulai game berikutnya; di multiplayer host yang memulai dan semua pemain ikut.
- Power-up 🧋 **es kopi** (`boostUntil`): lari 1,4× lebih cepat selama 5 detik.
- Snapshot multiplayer (sejak protokol **v2**, sekarang **v7**: poin di kolom ke-15, es kopi ke-16, terpeleset ke-17, genangan `pd`) membawa challenge, waktu rem, sisi pintu, posisi penumpang berdiri, power-up, serta status earphone dan pura-pura tidur tiap pemain. Pemain dengan versi game berbeda akan ditolak dengan pesan jelas.

## Tips sekali tampil (`src/ui/tips.ts`)

- Pertama kali sebuah item (es kopi, earphone, pura-pura tidur), challenge, atau aturan (kursi prioritas, kursi cukup untuk semua, kursi makin sedikit, stasiun terakhir) muncul, tampil penjelasan singkat yang menunjuk ke benda itu (lingkaran sorotan).
- **Lawan bot:** game dijeda (simulasi tidak maju) dan muncul kartu krem dengan tombol *Oke, mengerti!* (Enter/Spasi juga bisa). Kalau ada beberapa tips sekaligus, tampil bergantian.
- **Multiplayer / chat app:** tidak bisa dijeda, jadi tampil gelembung kecil yang hilang sendiri setelah 2 detik.
- Tips yang sudah tampil disimpan di pengaturan (`tipsSeen`), jadi tiap tips hanya muncul sekali per perangkat. Tombol *Tampilkan tips lagi* di Pengaturan mengulangnya.

## Web app (PWA)

- `vite-plugin-pwa` membuat `manifest.webmanifest` (layar penuh, landscape, ikon 192/512/maskable) dan `sw.js` (Workbox) yang menyimpan semua file game untuk offline, termasuk chat demo. Konfigurasinya di `vite.config.ts`.
- `ignoreURLParametersMatching: [/.*/]` membuat tautan dengan parameter (`?embed=messenger`, `?room=`, `?signal=`) tetap terbuka dari cache.
- `src/ui/pwa.ts` mendaftarkan service worker sendiri (tanpa `virtual:pwa-register`). Versi baru menunggu (`waiting`) dan hanya diaktifkan lewat pesan `SKIP_WAITING` saat game di menu utama tanpa koneksi multiplayer, lalu halaman di-reload sekali.
- Di dalam iframe chat app (`?embed=messenger`) service worker tidak didaftarkan; caching diurus oleh chat app.
- Ikon PNG di `public/` dibuat dari `public/icon.svg`. Kalau ikon diubah, render ulang ke `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (gambar di zona aman 80%), dan `apple-touch-icon.png` (180 px, latar penuh).

## Parameter URL untuk pengembangan

| Parameter | Fungsi |
|---|---|
| `?worker=https://…workers.dev` | Pakai Worker ini untuk kode room dan TURN (mengganti `VITE_SIGNAL_URL`) |
| `?signal=local` | Kode room lewat antar tab (tanpa internet), untuk tes WebRTC di satu browser |
| `?mock=messenger&user=u1` | Messenger tiruan (`u1` = host, `u2`–`u4` = peserta) |

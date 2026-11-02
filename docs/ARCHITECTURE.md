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

1. Host membuat kode 5 karakter. Topik MQTT dan kunci AES-GCM diturunkan dari kode itu, sehingga broker tidak bisa membaca isinya.
2. Pemain mengirim `hello` ke topik tersebut. Host membalas dengan offer WebRTC (kandidat ICE dikumpulkan di awal), lalu pemain membalas answer.
3. Setelah DataChannel terbuka, pemain berhenti memakai broker.
4. Dua broker publik (EMQX dan HiveMQ) dipakai sekaligus. Kalau satu mati, yang lain tetap jalan. Kondisinya dicek otomatis di CI (job `brokers`).

Keterbatasan: belum ada server TURN. Di sebagian jaringan seluler (CGNAT), koneksi langsung bisa gagal; Wi-Fi atau hotspot yang sama hampir selalu berhasil.

## Alur satu ronde

```
intro → riding (kereta jalan, goyang, lalu mengerem)
      → scramble (kursi kosong = pemain hidup − 1, plus 1 kursi prioritas jebakan)
      → result (yang berdiri gugur; kalau tidak ada yang duduk, stasiun diulang)
      → riding ... → gameOver
```

## Parameter URL untuk pengembangan

| Parameter | Fungsi |
|---|---|
| `?signal=local` | Kode room lewat antar tab (tanpa internet), untuk tes WebRTC di satu browser |
| `?mock=messenger&user=u1` | Messenger tiruan (`u1` = host, `u2`–`u4` = peserta) |

# Mini Game SDK: integrasi di messenger

Dokumen ini untuk sisi **aplikasi messenger**. Isinya: apa yang harus dibuat agar *Don't Take My Seat* (dan mini game lain nanti) bisa dimainkan di dalam chat, mirip Activities di Discord.

Versi SDK: **1**

## Gambaran

```
┌──────────── Messenger (HP Andi = host) ────────────┐
│  Chat UI ── kartu undangan ── WebView (game)        │
│                     ▲  JSON string  │               │
│                     │               ▼               │
│              window.miniGameReceive   MiniGameBridge│
│                     ▲               │               │
│        koneksi P2P messenger (WebRTC DataChannel)   │
└─────────────────────┼───────────────┼───────────────┘
                      │   ke HP Bunga, Cahya, Dewi
```

- Game berjalan di **WebView**. Messenger tidak perlu tahu aturan game.
- Messenger hanya **meneruskan data** antara game di HP yang berbeda lewat koneksi P2P yang sudah dimilikinya.
- Game memakai topologi **bintang**: host (pengundang) bertukar data dengan setiap pemain, dan pemain tidak saling mengirim data. Jadi messenger cukup bisa mengirim **host ↔ tiap peserta**.

## 1. Memuat game

| Mode | URL |
|---|---|
| Online (disarankan untuk uji coba) | `https://whiskey34.github.io/dont-take-my-seat/` |
| Bundel di dalam aplikasi | Salin isi `dist/` (hasil `npm run build`) ke aset aplikasi, lalu muat lewat `WebViewAssetLoader` (Android) atau skema lokal yang aman |

Pengaturan WebView:
- JavaScript aktif, DOM storage aktif, audio boleh diputar tanpa gesture.
- Layar penuh dan **landscape**.
- **Tolak navigasi** ke domain selain domain game.
- Debug build: `WebView.setWebContentsDebuggingEnabled(true)`, supaya console bisa dibuka lewat `chrome://inspect`.

## 2. Jembatan (bridge)

### Game → messenger

Game memanggil **salah satu** objek berikut (dicek berurutan), dengan satu argumen berupa **string JSON**:

| Platform | Yang perlu disediakan messenger |
|---|---|
| Android (Kotlin/Java) | `addJavascriptInterface(obj, "MiniGameBridge")` dengan method `@JavascriptInterface fun postMessage(json: String)` |
| Flutter (`webview_flutter`) | `addJavaScriptChannel('MiniGameBridge', onMessageReceived: ...)` |
| Flutter (`flutter_inappwebview`) | handler bernama `miniGame` |
| React Native (`react-native-webview`) | `onMessage` (game memakai `window.ReactNativeWebView.postMessage`) |
| iOS (WKWebView) | `userContentController.add(handler, name: "miniGame")` |

### Messenger → game

Panggil fungsi global dengan **string JSON** (jangan objek):

```kotlin
// Android
val js = "window.miniGameReceive(" + JSONObject.quote(json) + ")"
webView.evaluateJavascript(js, null)
```

```dart
// Flutter
controller.runJavaScript('window.miniGameReceive(${jsonEncode(json)})');
```

Semua panggilan harus di **thread UI**.

## 3. Pesan

### Dari game

| `type` | Isi | Yang dilakukan messenger |
|---|---|---|
| `ready` | `sdk`, `game`, `version` | Game sudah dimuat. Balas dengan `init`. |
| `send` | `to` (id pengguna), `channel` (`"fast"` / `"reliable"`), `data` (string) | Kirim `data` ke HP pengguna `to`, lalu di sana panggil game dengan pesan `message`. |
| `result` | `text`, `winner`, `ranking` (array nama) | Tampilkan kartu hasil di chat. Hanya dikirim oleh host. |
| `close` | – | Game ingin ditutup / pemain keluar. |

### Ke game

| `type` | Isi | Kapan |
|---|---|---|
| `init` | `sdk: 1`, `self: {id, name, lang}`, `session: {id, hostId, participants: [{id, name}]}` | Sebagai balasan `ready`. `hostId` = pengundang. `participants` = peserta lain yang **sudah membuka** game. |
| `message` | `from`, `channel`, `data` | Saat data dari HP lain tiba. |
| `peer` | `event: "join" \| "leave"`, `user: {id, name}` | Saat peserta membuka atau menutup game, atau koneksinya putus. |
| `lifecycle` | `state: "background" \| "foreground"` | Saat aplikasi di-*minimize* atau kembali. |

Contoh `init`:

```json
{
  "type": "init",
  "sdk": 1,
  "self": { "id": "u2", "name": "Bunga", "lang": "id" },
  "session": {
    "id": "game-7f3a",
    "hostId": "u1",
    "participants": [{ "id": "u1", "name": "Andi" }]
  }
}
```

## 4. Alur lengkap

1. Andi menekan 🎮 di grup, memilih game, lalu messenger mengirim **kartu undangan** berisi `sessionId` (pesan tersembunyi + kartu).
2. Andi membuka WebView. Game mengirim `ready`, messenger membalas `init` (Andi = host). Game Andi menampilkan lobby.
3. Bunga menekan "Ikut Main". Game Bunga mengirim `ready`, messenger membalas `init` dengan `participants: [Andi]`. Di HP Andi, messenger mengirim `peer join Bunga`.
4. Game Bunga mengirim pesan `hello` ke Andi lewat `send`. Lobby Andi bertambah.
5. Andi menekan **Mulai**. Tempat kosong diisi bot.
6. Selama main: host mengirim ±20 snapshot per detik ke setiap pemain (`fast`) plus event (`reliable`). Setiap pemain mengirim ±30 input per detik ke host (`fast`).
7. Game selesai: host mengirim `result`, lalu messenger menampilkan kartu hasil di chat.

## 5. Kebutuhan koneksi

| | |
|---|---|
| `channel: "fast"` | Sebaiknya DataChannel **unordered, `maxRetransmits: 0`**. Boleh hilang. |
| `channel: "reliable"` | DataChannel ordered dan reliable (seperti untuk pesan chat). |
| Ukuran pesan | < 4 KB (snapshot ±1 KB). |
| Laju | Host: ±20–40 pesan/detik per pemain. Pemain: ±30 pesan/detik. |
| Topologi | Host harus bisa mengirim ke tiap peserta. Pemain cukup ke host. |

Kalau messenger hanya punya channel reliable, kirim `fast` lewat reliable juga. Game tetap jalan, tapi gerakan pemain lain bisa sedikit tersendat saat sinyal buruk.

Pesan game **tidak boleh** disimpan sebagai pesan chat, tidak memicu notifikasi, dan tidak perlu dienkripsi ulang kalau koneksinya sudah terenkripsi (DTLS).

## 6. Keamanan

- Hanya teruskan `send` ke peserta **sesi yang sama**. Abaikan `to` lain.
- Game tidak bisa mengakses apa pun selain pesan di atas: tidak ada isi chat, kontak, atau file.
- Game memvalidasi semua data yang masuk; data rusak diabaikan.

## 7. Uji coba tanpa messenger

Buka game di beberapa tab browser yang sama:

```
https://whiskey34.github.io/dont-take-my-seat/?mock=messenger&user=u1   ← host (Andi)
https://whiskey34.github.io/dont-take-my-seat/?mock=messenger&user=u2   ← Bunga
https://whiskey34.github.io/dont-take-my-seat/?mock=messenger&user=u3   ← Cahya
```

Messenger tiruan ini (`src/net/mockMessenger.ts`) memakai pesan yang persis sama dengan dokumen ini, jadi bisa dijadikan contoh implementasi.

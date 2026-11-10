# dtms-signal: Cloudflare Worker untuk Don't Take My Seat

Worker kecil ini punya dua tugas:

| Endpoint | Fungsi |
|---|---|
| `GET /room/<topik>` (WebSocket, port 443) | Tempat bertemu pemain dengan kode room yang sama. Satu kode room = satu Durable Object. Isi pesan sudah dienkripsi dengan kode room, jadi Worker tidak bisa membacanya. |
| `GET /turn` | Kredensial **Cloudflare TURN** yang berlaku 4 jam (port 443, 80, 3478, 5349). Ini yang membuat HP di Indosat, XL, Biznet, dll. tetap bisa tersambung walau port langsung diblokir. |
| `GET /scores`, `POST /scores` | **Papan peringkat**: poin terbaik dan jumlah menang per perangkat, disimpan di SQLite milik Durable Object `Leaderboard` (gratis, tidak perlu membuat database terpisah). |
| `GET /` | Cek hidup (`dtms-signal ok`). |

Game tetap berjalan tanpa Worker (pakai relay publik + STUN), tetapi dengan Worker koneksi jauh lebih stabil. Relay publik tetap dipakai bersamaan sebagai cadangan.

Biaya: paket **Workers Free** cukup (Durable Objects dengan SQLite tersedia di paket gratis, 100.000 request per hari). TURN gratis untuk 1.000 GB pertama per bulan, setelahnya $0,05 per GB. Kartu kredit tidak diminta untuk Workers Free, tetapi Cloudflare mungkin memintanya untuk Realtime/TURN.

## Pasang lewat GitHub Actions (disarankan)

1. **Akun Cloudflare.** Daftar di <https://dash.cloudflare.com/sign-up>. Catat **Account ID** (halaman *Workers & Pages* → kolom kanan, atau di URL dashboard).
2. **Kunci TURN.** Dashboard → **Realtime** → **TURN Server** → **Create**. Beri nama (mis. `dtms`), lalu salin **Turn Token ID** dan **API Token**. Token hanya tampil sekali.
3. **API token untuk deploy.** Klik foto profil → **My Profile** → **API Tokens** → **Create Token** → template **Edit Cloudflare Workers** → *Continue to summary* → *Create Token*. Salin tokennya.
4. **Secret di GitHub.** Repo → **Settings** → **Secrets and variables** → **Actions** → tab **Secrets** → *New repository secret*, buat 4 secret:
   - `CLOUDFLARE_API_TOKEN` = token langkah 3
   - `CLOUDFLARE_ACCOUNT_ID` = Account ID langkah 1
   - `TURN_KEY_ID` = Turn Token ID langkah 2
   - `TURN_KEY_API_TOKEN` = API Token langkah 2
5. **Deploy Worker.** Tab **Actions** → **Worker (Cloudflare)** → **Run workflow**. Setelah hijau, buka ringkasan run: di sana tertulis URL Worker, misalnya `https://dtms-signal.namamu.workers.dev`, dan hasil cek `TURN enabled: true`.
6. **Sambungkan game ke Worker.** **Settings** → **Secrets and variables** → **Actions** → tab **Variables** → *New repository variable*: nama `SIGNAL_URL`, isi URL dari langkah 5 (tanpa `/` di akhir).
7. **Deploy ulang game.** **Actions** → **Web (GitHub Pages)** → **Run workflow**. Selesai.

Untuk mencoba Worker tanpa deploy ulang game, buka game dengan `?worker=https://dtms-signal.namamu.workers.dev`.

## Domain yang diizinkan

Worker hanya melayani halaman dari domain di `ALLOWED_ORIGINS` (`wrangler.toml`), supaya kuota TURN tidak dipakai situs lain. Kalau game dipasang di domain lain (mis. domain chat app), tambahkan domainnya di sana lalu deploy ulang Worker.

## Menjalankan di komputer sendiri

```bash
cd worker
npm install
npm run dev            # http://localhost:8787, tanpa TURN (STUN saja)
```

Lalu buka game lokal dengan `?worker=http://localhost:8787`. Untuk mencoba TURN secara lokal, buat file `worker/.dev.vars` (sudah di-*ignore* git):

```
TURN_KEY_ID=...
TURN_KEY_API_TOKEN=...
```

Deploy manual (tanpa GitHub Actions): `npx wrangler login`, `npx wrangler deploy`, lalu `npx wrangler secret put TURN_KEY_ID` dan `npx wrangler secret put TURN_KEY_API_TOKEN`.

## Keamanan

- Token TURN dan token Cloudflare **hanya** disimpan sebagai secret (GitHub dan Worker), tidak pernah ada di kode game.
- Kredensial TURN untuk pemain berlaku 4 jam dan dibagikan ulang per isolate selama 30 menit.
- Satu room dibatasi 16 koneksi dan pesan maksimal 16 KB.

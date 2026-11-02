# Mini Game SDK untuk chat app (Ionic + Capacitor)

Modul ini dipasang di **chat app kamu**, supaya mini game seperti *Don't Take My Seat* bisa dimainkan langsung di dalam chat, seperti Activities di Discord.

- Game dibuka sebagai **iframe layar penuh** di atas chat. Tidak perlu WebView native tambahan.
- Data game lewat **koneksi WebRTC yang sudah dimiliki chat app kamu**: modul menambahkan 2 DataChannel khusus game ke setiap koneksi.
- Undangan dan hasil game adalah **pesan chat biasa** dengan tipe khusus.
- Tanpa server tambahan.

Coba dulu cara kerjanya di chat demo (buka di 2–3 tab):
`https://whiskey34.github.io/dont-take-my-seat/messenger-sdk/demo/index.html?user=u1` (lalu `user=u2`, `user=u3`)

Kode demo (`demo/main.ts`) adalah contoh pemasangan lengkap. Cari tulisan `SDK:` di sana.

## Isi

| File | Fungsi |
|---|---|
| `src/gameChannels.ts` | `GameLinks`: menambah kanal game ke `RTCPeerConnection` dan mengirim/menerima data game |
| `src/host.ts` | `MiniGameHost`: membuka game di iframe dan menghubungkannya ke `GameLinks` |
| `src/session.ts` | Logika sesi (siapa host, siapa bergabung, penerusan data). Tanpa DOM, dan sudah dites |
| `src/invite.ts` | Membuat dan memvalidasi undangan, kartu hasil, dan kartu siap pakai (opsional) |

## Pemasangan

### 1. Salin modul

Salin folder `messenger-sdk/src` ke proyek Ionic, misalnya ke `src/app/minigames/`. Modul ini tidak punya dependensi tambahan dan bisa dipakai di Angular, React, maupun Vue.

### 2. Tambahkan kanal game ke setiap koneksi P2P

Di tempat chat app membuat `RTCPeerConnection` dengan kontak, panggil `attach` **di kedua sisi**, tepat setelah koneksi dibuat dan **sebelum** offer/answer:

```ts
import { GameLinks } from './minigames';

export const gameLinks = new GameLinks(); // satu untuk seluruh app

const pc = new RTCPeerConnection(config);
gameLinks.attach(contactUserId, pc); // ← tambahkan baris ini
// ... kode chat yang sudah ada: createDataChannel('chat'), createOffer(), dst.
```

Kanal game memakai id tetap (1001 dan 1002) dengan mode `negotiated`, jadi tidak perlu signaling tambahan. Pastikan chat app tidak memakai id yang sama.

### 3. Buat `MiniGameHost` dan sambungkan

```ts
import { MiniGameHost } from './minigames';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { App } from '@capacitor/app';

export const games = new MiniGameHost({
  link: gameLinks,
  // default: https://whiskey34.github.io/dont-take-my-seat/
  onOpen: () => ScreenOrientation.lock({ orientation: 'landscape' }),
  onClosed: () => ScreenOrientation.unlock(),
});

gameLinks.setMessageHandler((from, ch, data) => games.handlePeerMessage(from, ch, data));
gameLinks.setStateHandler((userId, up) => games.handlePeerState(userId, up));

App.addListener('appStateChange', ({ isActive }) => games.handleLifecycle(isActive));
App.addListener('backButton', () => {
  if (games.isOpen) games.close(); // tombol back menutup game, bukan app
});
```

Plugin yang dipakai: `npm i @capacitor/screen-orientation @capacitor/app`, lalu `npx cap sync`.

### 4. Undangan: kirim sebagai pesan chat

Saat pengguna menekan tombol 🎮 di ruang chat:

```ts
import { createInvite } from './minigames';

const invite = createInvite({ id: me.id, name: me.name });
chatService.send(chatId, { type: 'minigame-invite', payload: invite }); // pakai cara kirim pesan yang sudah ada
openGame(invite); // pengundang langsung masuk sebagai host
```

### 5. Tampilkan kartu undangan, lalu gabung

Saat menampilkan pesan bertipe `minigame-invite`:

```ts
import { parseInvite, renderInviteCard } from './minigames';

const invite = parseInvite(message.payload); // selalu validasi isi dari luar
if (invite) {
  // Pakai komponen Ionic sendiri, atau kartu siap pakai:
  const card = renderInviteCard(invite, { eyebrow: 'Mini game', invitedBy: 'Diundang oleh', join: 'Ikut main' }, () => openGame(invite));
  container.append(card);
}
```

```ts
function openGame(invite: GameInvite) {
  games.open({
    invite,
    self: { id: me.id, name: me.name, lang: 'id' },
    // Hanya HP host yang memanggil ini: kirim kartu hasil ke chat.
    onResult: (card) => chatService.send(chatId, { type: 'minigame-result', payload: card }),
  });
}
```

Pesan `minigame-result` bisa ditampilkan dengan `renderResultCard(card)` atau komponen sendiri.

### 6. Content Security Policy

Kalau `index.html` chat app memakai CSP, izinkan iframe game:

```html
<meta http-equiv="Content-Security-Policy" content="... frame-src https://whiskey34.github.io;" />
```

## Sisi Kotlin

Untuk cara iframe ini, **tidak ada kode Kotlin yang wajib diubah**. Yang perlu dicek:

- Kalau `MainActivity` mengubah pengaturan WebView, pastikan JavaScript dan DOM storage tetap aktif.
- Kalau mau suara game langsung bunyi tanpa ketukan, tambahkan di `MainActivity.onStart()`:
  `bridge.webView.settings.mediaPlaybackRequiresUserGesture = false`
- Kalau koneksi WebRTC chat kamu **berjalan di Kotlin** (bukan di JavaScript), `GameLinks` tidak bisa dipakai. Buat implementasi `PeerLink` sendiri (fungsi `send(userId, channel, data)`) yang meneruskan data ke Kotlin lewat plugin Capacitor, lalu panggil `games.handlePeerMessage(...)` saat data masuk.

## Main tanpa internet (opsional)

Supaya game tetap bisa dibuka tanpa internet, bundel game di dalam chat app:

1. Unduh hasil build game: folder `dist/` dari repo ini (`npm run build`).
2. Salin isinya ke `public/minigames/dont-take-my-seat/` di proyek Ionic.
3. Isi `gameUrl: '/minigames/dont-take-my-seat/index.html'` saat membuat `MiniGameHost`.

## Alur di balik layar

```
Andi (host)                         Bunga (pemain)
  🎮 → createInvite → pesan chat ──▶ kartu undangan → Ikut main
  games.open(invite)                  games.open(invite)
  game: ready → init (host)           game: ready → init (pemain)
                          ◀── join ── kanal game (reliable)
                         ── welcome ─▶
  game: lobby bertambah               game: menunggu host
  Mulai ─── snapshot 20×/dtk (fast) ─▶  input 30×/dtk (fast) ─── ▶
  selesai → onResult → pesan chat ──▶ kartu hasil
```

Detail pesan antara game dan chat app ada di [`../docs/MESSENGER_SDK.md`](../docs/MESSENGER_SDK.md).

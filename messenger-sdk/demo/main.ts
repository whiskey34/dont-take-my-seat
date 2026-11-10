/**
 * A tiny stand-in for the real chat app, showing exactly where the
 * Mini Game SDK plugs in. Search for "SDK:" to find the integration points.
 *
 * Devices find each other with a room code and then talk over real WebRTC
 * connections, like a P2P chat app.
 */
import { getIceServers } from '../../src/net/rtc/ice';
import { LocalSignaling } from '../../src/net/signal/local';
import { RoomSignaling } from '../../src/net/signal/roomSignaling';
import { newRoomCode, normalizeCode, type Signaling, type SignalMsg } from '../../src/net/signal/signal';
import { createInvite, GameLinks, MiniGameHost, parseInvite, renderInviteCard, renderResultCard, type GameInvite, type GameResultCard } from '../src';

const USERS = [
  { id: 'u1', name: 'Andi' },
  { id: 'u2', name: 'Bunga' },
  { id: 'u3', name: 'Cahya' },
  { id: 'u4', name: 'Dewi' },
];
const params = new URLSearchParams(location.search);
const me = USERS.find((u) => u.id === params.get('user')) ?? USERS[0]!;
// Everyone with the same room code is in the same demo chat.
const room = normalizeCode(params.get('room') ?? '') ?? newRoomCode(() => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
if (params.get('room') !== room) {
  params.set('room', room);
  history.replaceState(null, '', `?${params.toString()}`);
}
const $ = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------- SDK: setup

// SDK: one GameLinks for the whole app; it adds game channels to each P2P connection.
const gameLinks = new GameLinks();
// SDK: one MiniGameHost; it opens games full screen and wires them to the links.
const games = new MiniGameHost({
  link: gameLinks,
  // The demo is published next to the game; a real app would use the default
  // GitHub Pages URL or a copy bundled in the app.
  gameUrl: params.get('game') ?? new URL('../../index.html', location.href).toString(),
});
gameLinks.setMessageHandler((from, channel, data) => games.handlePeerMessage(from, channel, data));
gameLinks.setStateHandler((userId, connected) => games.handlePeerState(userId, connected));
document.addEventListener('visibilitychange', () => games.handleLifecycle(!document.hidden));

// ---------------------------------------------------------------- chat P2P (your app already has this)

// Devices meet through the game's room-code signaling (encrypted public
// MQTT brokers), standing in for the chat app's own signaling. Add
// ?signal=local to connect tabs of one browser without internet.
const chatChannels = new Map<string, RTCDataChannel>();
const signal: Signaling = params.get('signal') === 'local' ? new LocalSignaling(`demo-${room}`) : new RoomSignaling(`demo-${room}`);

// Cloudflare TURN when the Worker is configured (like the chat app's own TURN), else STUN.
let iceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
void getIceServers().then((s) => (iceServers = s));

function newConnection(peerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers });
  // SDK: attach game channels right after creating the connection, on both sides.
  gameLinks.attach(peerId, pc);
  const chat = pc.createDataChannel('chat', { negotiated: true, id: 0 });
  chat.onopen = () => {
    chatChannels.set(peerId, chat);
    updatePeers();
  };
  chat.onclose = () => {
    chatChannels.delete(peerId);
    updatePeers();
  };
  chat.onmessage = (e) => receiveChat(peerId, JSON.parse(String(e.data)));
  pc.onconnectionstatechange = () => {
    // Forget failed connections so the next hello can try again.
    if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && pcs.get(peerId) === pc) pcs.delete(peerId);
    updatePeers();
  };
  return pc;
}

const pcs = new Map<string, RTCPeerConnection>();

async function gathered(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, iceServers.some((s) => String(s.urls).includes('turn')) ? 5000 : 2500);
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(t), resolve()));
    });
  }
  return pc.localDescription?.sdp ?? '';
}

signal.onMessage(async (m: SignalMsg) => {
  if (m.from === me.id) return;
  if (m.type === 'hello') {
    if (pcs.has(m.from)) return;
    // The lower id makes the offer; the other one says hello back.
    if (me.id < m.from) {
      const pc = newConnection(m.from);
      pcs.set(m.from, pc);
      await pc.setLocalDescription(await pc.createOffer());
      signal.publish({ type: 'offer', from: me.id, to: m.from, sdp: await gathered(pc) });
    } else {
      signal.publish({ type: 'hello', from: me.id });
    }
  } else if (m.type === 'offer' && m.to === me.id) {
    pcs.get(m.from)?.close();
    const pc = newConnection(m.from);
    pcs.set(m.from, pc);
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    signal.publish({ type: 'answer', from: me.id, to: m.from, sdp: await gathered(pc) });
  } else if (m.type === 'answer' && m.to === me.id) {
    await pcs
      .get(m.from)
      ?.setRemoteDescription({ type: 'answer', sdp: m.sdp })
      .catch(() => {});
  }
});

let signalState: 'connecting' | 'ready' | 'failed' = 'connecting';
signal.ready
  .then(() => {
    signalState = 'ready';
    const hello = () => signal.publish({ type: 'hello', from: me.id });
    hello();
    // Keep saying hello so devices that open the page later find us.
    setInterval(hello, 3000);
    updatePeers();
  })
  .catch(() => {
    signalState = 'failed';
    updatePeers();
  });
window.addEventListener('pagehide', () => pcs.forEach((pc) => pc.close()));

// ---------------------------------------------------------------- chat messages

type ChatMsg = { kind: 'text'; text: string } | { kind: 'invite'; invite: GameInvite } | { kind: 'result'; card: GameResultCard };

function broadcast(msg: ChatMsg): void {
  for (const ch of chatChannels.values()) if (ch.readyState === 'open') ch.send(JSON.stringify(msg));
  show(me.id, msg);
}

function receiveChat(from: string, msg: ChatMsg): void {
  show(from, msg);
}

function nameOf(id: string): string {
  return USERS.find((u) => u.id === id)?.name ?? id;
}

function show(from: string, msg: ChatMsg): void {
  const mine = from === me.id;
  const log = $('log');
  if (msg.kind === 'text') {
    const el = document.createElement('div');
    el.className = mine ? 'msg mine' : 'msg';
    el.append(Object.assign(document.createElement('span'), { className: 'who', textContent: nameOf(from) }), msg.text);
    log.append(el);
  } else {
    const row = document.createElement('div');
    row.className = mine ? 'card-row mine-card' : 'card-row';
    row.append(Object.assign(document.createElement('span'), { className: 'who', textContent: nameOf(from) }));
    if (msg.kind === 'invite') {
      // SDK: an invite is a normal chat message; validate it before use.
      const invite = parseInvite(msg.invite);
      if (!invite) return;
      row.append(renderInviteCard(invite, { eyebrow: 'Mini game', invitedBy: 'Invited by', join: mine ? 'Open' : 'Join game' }, () => openGame(invite)));
    } else {
      row.append(renderResultCard(msg.card));
    }
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
}

// SDK: opening a game, as host (own invite) or player (someone else's invite).
function openGame(invite: GameInvite): void {
  games.open({
    invite,
    self: { ...me, lang: navigator.language },
    onResult: (card) => broadcast({ kind: 'result', card }),
  });
}

$('btnGame').addEventListener('click', () => {
  // SDK: create the invite, post it to the chat, then open the game as host.
  const invite = createInvite(me);
  broadcast({ kind: 'invite', invite });
  openGame(invite);
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('text') as HTMLInputElement;
  if (input.value.trim()) broadcast({ kind: 'text', text: input.value.trim() });
  input.value = '';
});

function updatePeers(): void {
  const names = [...chatChannels.keys()].map(nameOf);
  $('peers').textContent =
    signalState === 'failed'
      ? 'Offline: cannot reach the matchmaking service'
      : names.length
        ? `Online: ${names.join(', ')}`
        : signalState === 'connecting'
          ? 'Connecting…'
          : 'Waiting for others…';
}

function showShareLinks(): void {
  const box = $('share');
  box.replaceChildren();
  for (const u of USERS.filter((x) => x.id !== me.id)) {
    const p = new URLSearchParams(params);
    p.set('user', u.id);
    const url = `${location.origin}${location.pathname}?${p.toString()}`;
    const row = document.createElement('div');
    const label = Object.assign(document.createElement('span'), { textContent: `${u.name}: ` });
    const link = Object.assign(document.createElement('a'), { href: url, textContent: url, target: '_blank' });
    row.append(label, link);
    box.append(row);
  }
  $('roomCode').textContent = room;
}

showShareLinks();
$('me').textContent = `${me.name} (demo chat)`;
updatePeers();

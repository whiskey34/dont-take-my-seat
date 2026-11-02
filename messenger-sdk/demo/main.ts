/**
 * A tiny stand-in for the real chat app, showing exactly where the
 * Mini Game SDK plugs in. Search for "SDK:" to find the integration points.
 *
 * Tabs find each other through BroadcastChannel (standing in for the chat's
 * own signaling) and then talk over real WebRTC connections.
 */
import { createInvite, GameLinks, MiniGameHost, parseInvite, renderInviteCard, renderResultCard, type GameInvite, type GameResultCard } from '../src';

const USERS = [
  { id: 'u1', name: 'Andi' },
  { id: 'u2', name: 'Bunga' },
  { id: 'u3', name: 'Cahya' },
  { id: 'u4', name: 'Dewi' },
];
const params = new URLSearchParams(location.search);
const me = USERS.find((u) => u.id === params.get('user')) ?? USERS[0]!;
const room = params.get('room') ?? 'demo';
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

const chatChannels = new Map<string, RTCDataChannel>();
const signal = new BroadcastChannel(`mg-demo-${room}`);
type Sig = { kind: 'here'; from: string } | { kind: 'offer' | 'answer'; from: string; to: string; sdp: string };

function newConnection(peerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
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
  return pc;
}

const pcs = new Map<string, RTCPeerConnection>();

async function gathered(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(t), resolve()));
    });
  }
  return pc.localDescription?.sdp ?? '';
}

signal.onmessage = async (e: MessageEvent<Sig>) => {
  const m = e.data;
  if (m.from === me.id) return;
  if (m.kind === 'here') {
    // The lower id makes the offer; the other one answers.
    if (me.id < m.from && !pcs.has(m.from)) {
      const pc = newConnection(m.from);
      pcs.set(m.from, pc);
      await pc.setLocalDescription(await pc.createOffer());
      signal.postMessage({ kind: 'offer', from: me.id, to: m.from, sdp: await gathered(pc) } satisfies Sig);
    } else if (me.id > m.from && !pcs.has(m.from)) {
      signal.postMessage({ kind: 'here', from: me.id } satisfies Sig);
    }
  } else if (m.kind === 'offer' && m.to === me.id) {
    pcs.get(m.from)?.close();
    const pc = newConnection(m.from);
    pcs.set(m.from, pc);
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    signal.postMessage({ kind: 'answer', from: me.id, to: m.from, sdp: await gathered(pc) } satisfies Sig);
  } else if (m.kind === 'answer' && m.to === me.id) {
    await pcs.get(m.from)?.setRemoteDescription({ type: 'answer', sdp: m.sdp });
  }
};
signal.postMessage({ kind: 'here', from: me.id } satisfies Sig);
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
  $('peers').textContent = names.length ? `Online: ${names.join(', ')}` : 'Waiting for other tabs…';
}

$('me').textContent = `${me.name} (demo chat)`;
updatePeers();

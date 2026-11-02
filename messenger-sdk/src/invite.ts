/**
 * Invites and result cards are ordinary chat messages with a special type.
 * The chat app stores and syncs them like any other message.
 */

export interface GameInvite {
  type: 'minigame-invite';
  v: 1;
  game: string;
  title: string;
  sessionId: string;
  hostId: string;
  hostName: string;
  maxPlayers: number;
  createdAt: number;
}

export interface GameResultCard {
  type: 'minigame-result';
  v: 1;
  game: string;
  sessionId: string;
  text: string;
  winner: string | null;
  ranking: string[];
}

export const DONT_TAKE_MY_SEAT = { id: 'dont-take-my-seat', title: "Don't Take My Seat", maxPlayers: 4 } as const;

export function createInvite(host: { id: string; name: string }, game: { id: string; title: string; maxPlayers: number } = DONT_TAKE_MY_SEAT): GameInvite {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const sessionId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return { type: 'minigame-invite', v: 1, game: game.id, title: game.title, sessionId, hostId: host.id, hostName: host.name, maxPlayers: game.maxPlayers, createdAt: Date.now() };
}

export function parseInvite(v: unknown): GameInvite | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  const s = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length < 100;
  if (m.type !== 'minigame-invite' || m.v !== 1 || !s(m.game) || !s(m.sessionId) || !s(m.hostId)) return null;
  return {
    type: 'minigame-invite',
    v: 1,
    game: m.game as string,
    title: s(m.title) ? (m.title as string) : (m.game as string),
    sessionId: m.sessionId as string,
    hostId: m.hostId as string,
    hostName: s(m.hostName) ? (m.hostName as string) : '?',
    maxPlayers: Number(m.maxPlayers) || 4,
    createdAt: Number(m.createdAt) || 0,
  };
}

export function createResultCard(invite: GameInvite, r: { text: string; winner: string | null; ranking: string[] }): GameResultCard {
  return { type: 'minigame-result', v: 1, game: invite.game, sessionId: invite.sessionId, text: r.text, winner: r.winner, ranking: r.ranking };
}

const CARD_STYLE = `
.mg-card{display:flex;flex-direction:column;gap:8px;max-width:260px;padding:12px 14px;border-radius:14px;
  background:#17232f;color:#f4f6f8;font:14px/1.35 system-ui,sans-serif;border-bottom:3px solid #ffc02e}
.mg-card .mg-eyebrow{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#ffc02e}
.mg-card .mg-title{font-size:16px;font-weight:800}
.mg-card .mg-sub{color:#a9b6c2;font-size:12px}
.mg-card button{height:38px;border:0;border-radius:10px;background:#ffc02e;color:#14202b;font-weight:800;font-size:14px;cursor:pointer}
.mg-card.result{border-bottom-color:#22c55e}
.mg-card ol{margin:0;padding-left:18px;font-size:13px}`;

function ensureStyle(): void {
  if (document.getElementById('mg-card-style')) return;
  const style = document.createElement('style');
  style.id = 'mg-card-style';
  style.textContent = CARD_STYLE;
  document.head.append(style);
}

/**
 * Optional ready-made card for an invite. Ionic apps can also render
 * `GameInvite` with their own component instead.
 */
export function renderInviteCard(invite: GameInvite, labels: { eyebrow: string; invitedBy: string; join: string }, onJoin: () => void): HTMLElement {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'mg-card';
  const line = (cls: string, text: string) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: labels.join });
  button.addEventListener('click', onJoin);
  el.append(line('mg-eyebrow', labels.eyebrow), line('mg-title', invite.title), line('mg-sub', `${labels.invitedBy} ${invite.hostName}`), button);
  return el;
}

export function renderResultCard(card: GameResultCard): HTMLElement {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'mg-card result';
  const title = Object.assign(document.createElement('div'), { className: 'mg-title', textContent: card.text });
  const list = document.createElement('ol');
  list.append(...card.ranking.map((n) => Object.assign(document.createElement('li'), { textContent: n })));
  el.append(title, list);
  return el;
}

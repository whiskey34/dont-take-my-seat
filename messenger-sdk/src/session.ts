/**
 * One mini game session on one device, as seen by the chat app.
 *
 * Sits between the game (running in an iframe) and the chat's P2P links:
 * - answers the game's `ready` with `init` (who am I, who hosts),
 * - lets players find the host (`join` / `welcome`),
 * - forwards game data between devices, wrapped with the session id.
 *
 * No DOM here, so it can be unit-tested and reused with a native WebView.
 */

export type Channel = 'reliable' | 'fast';

export interface ChatUser {
  id: string;
  name: string;
}

/** How the session reaches other devices: implemented by the chat app (see gameChannels.ts). */
export interface PeerLink {
  send(userId: string, channel: Channel, data: string): void;
}

/** Wire format between chat apps (inside the game data channels). */
export type Envelope =
  | { g: 1; s: string; k: 'join'; u: ChatUser }
  | { g: 1; s: string; k: 'welcome'; u: ChatUser }
  | { g: 1; s: string; k: 'leave'; u: ChatUser }
  | { g: 1; s: string; k: 'd'; d: string };

export interface GameResult {
  text: string;
  winner: string | null;
  ranking: string[];
}

export interface SessionOptions {
  sessionId: string;
  hostId: string;
  self: ChatUser & { lang?: string };
  link: PeerLink;
  /** Delivers a JSON string to the game. */
  toGame: (json: string) => void;
  onResult?: (r: GameResult) => void;
  onClose?: () => void;
  maxPlayers?: number;
}

const JOIN_RETRY_MS = 1500;

export function parseEnvelope(raw: string): Envelope | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (e.g !== 1 || typeof e.s !== 'string') return null;
  const user = (u: unknown): u is ChatUser =>
    typeof u === 'object' && u !== null && typeof (u as ChatUser).id === 'string' && typeof (u as ChatUser).name === 'string';
  if ((e.k === 'join' || e.k === 'welcome' || e.k === 'leave') && user(e.u)) return { g: 1, s: e.s, k: e.k, u: { id: e.u.id, name: e.u.name } };
  if (e.k === 'd' && typeof e.d === 'string') return { g: 1, s: e.s, k: 'd', d: e.d };
  return null;
}

export class MiniGameSession {
  readonly id: string;
  private readonly isHost: boolean;
  private readonly members = new Map<string, ChatUser>(); // devices in this session (host: players; player: the host)
  private gameReady = false;
  private joinTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly o: SessionOptions) {
    this.id = o.sessionId;
    this.isHost = o.self.id === o.hostId;
  }

  /** A JSON string the game sent to the chat app. */
  fromGame(json: string): void {
    if (this.closed) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.type) {
      case 'ready':
        this.gameReady = true;
        this.sendToGame({
          type: 'init',
          sdk: 1,
          self: this.o.self,
          session: { id: this.id, hostId: this.o.hostId, participants: [...this.members.values()] },
        });
        if (!this.isHost) this.startJoining();
        break;
      case 'send': {
        const to = m.to;
        if (typeof to !== 'string' || typeof m.data !== 'string' || !this.members.has(to)) return;
        const channel: Channel = m.channel === 'fast' ? 'fast' : 'reliable';
        this.o.link.send(to, channel, JSON.stringify({ g: 1, s: this.id, k: 'd', d: m.data } satisfies Envelope));
        break;
      }
      case 'result':
        if (typeof m.text === 'string') {
          this.o.onResult?.({
            text: m.text,
            winner: typeof m.winner === 'string' ? m.winner : null,
            ranking: Array.isArray(m.ranking) ? m.ranking.filter((x): x is string => typeof x === 'string') : [],
          });
        }
        break;
      case 'close':
        this.close();
        break;
    }
  }

  /** A game-channel message from another device. Returns false if it is not for this session. */
  fromPeer(from: string, channel: Channel, env: Envelope): boolean {
    if (env.s !== this.id || this.closed) return false;
    switch (env.k) {
      case 'join':
        if (!this.isHost || env.u.id !== from) return true;
        if (!this.members.has(from) && this.members.size >= (this.o.maxPlayers ?? 4) - 1) return true; // full: the game would refuse anyway
        this.addMember(env.u);
        this.o.link.send(from, 'reliable', JSON.stringify({ g: 1, s: this.id, k: 'welcome', u: this.o.self } satisfies Envelope));
        break;
      case 'welcome':
        if (this.isHost || from !== this.o.hostId) return true;
        this.stopJoining();
        this.addMember(env.u);
        break;
      case 'leave':
        if (env.u.id === from) this.removeMember(from);
        break;
      case 'd':
        if (this.members.has(from)) this.sendToGame({ type: 'message', from, channel, data: env.d });
        break;
    }
    return true;
  }

  /** Tell the session when a P2P link to someone drops (or comes back). */
  peerConnection(userId: string, connected: boolean): void {
    if (!connected) this.removeMember(userId);
    else if (!this.isHost && userId === this.o.hostId && !this.members.has(userId)) this.startJoining();
  }

  /** Lifecycle of the chat app (backgrounded, resumed). */
  lifecycle(state: 'background' | 'foreground'): void {
    this.sendToGame({ type: 'lifecycle', state });
  }

  close(): void {
    if (this.closed) return;
    const bye = JSON.stringify({ g: 1, s: this.id, k: 'leave', u: { id: this.o.self.id, name: this.o.self.name } } satisfies Envelope);
    for (const id of this.members.keys()) this.o.link.send(id, 'reliable', bye);
    this.stopJoining();
    this.closed = true;
    this.members.clear();
    this.o.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private startJoining(): void {
    if (this.joinTimer || this.closed) return;
    const join = () => this.o.link.send(this.o.hostId, 'reliable', JSON.stringify({ g: 1, s: this.id, k: 'join', u: { id: this.o.self.id, name: this.o.self.name } } satisfies Envelope));
    join();
    this.joinTimer = setInterval(join, JOIN_RETRY_MS);
  }

  private stopJoining(): void {
    if (this.joinTimer) clearInterval(this.joinTimer);
    this.joinTimer = null;
  }

  private addMember(u: ChatUser): void {
    if (this.members.has(u.id)) return;
    this.members.set(u.id, u);
    if (this.gameReady) this.sendToGame({ type: 'peer', event: 'join', user: u });
  }

  private removeMember(id: string): void {
    const u = this.members.get(id);
    if (!u) return;
    this.members.delete(id);
    if (this.gameReady) this.sendToGame({ type: 'peer', event: 'leave', user: u });
  }

  private sendToGame(msg: unknown): void {
    this.o.toGame(JSON.stringify(msg));
  }
}

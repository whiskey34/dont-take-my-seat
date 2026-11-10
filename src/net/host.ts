import { CONFIG } from '../core/config';
import type { GameEvent, GameState, PlayerInput, PlayerSetup } from '../core/types';
import { Simulation, type Difficulty, type GameSession } from '../session/session';
import { cleanName, MAX_NAME, packSnapshot, parseClientMsg, PROTOCOL_VERSION, type HostMsg, type LobbyPlayer } from './protocol';
import type { Channel, Transport } from './transport';

const SNAP_INTERVAL = 1 / 20;

/** Bots are named bot_user_1, bot_user_2, … everywhere. */
export const botName = (n: number): string => `bot_user_${n}`;

/** Two players called "Budi" become "Budi" and "Budi 2". */
export function uniqueName(wanted: string, players: readonly LobbyPlayer[], selfId: string): string {
  const base = cleanName(wanted);
  const taken = new Set(players.filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface HostCallbacks {
  lobby(players: LobbyPlayer[]): void;
}

/**
 * A person in the room. `id` is their player id for the whole game; `peer`
 * is the connection they are using right now (null while disconnected).
 * `key` identifies their device so they can come back after leaving.
 */
interface Member {
  id: string;
  name: string;
  key: string;
  peer: string | null;
}

interface CurrentGame {
  session: HostSession;
  seed: number;
  setups: PlayerSetup[];
  difficulty: Difficulty;
}

/**
 * The host owns the room: it admits players, starts games and runs the
 * authoritative simulation. Other devices only send input.
 *
 * During a game nobody is replaced: a player whose device drops out keeps
 * their character (standing still) and can join again with the room code.
 */
export class HostNet {
  private members: Member[];
  private game: CurrentGame | null = null;

  constructor(
    private readonly transport: Transport,
    hostName: string,
    private readonly cb: HostCallbacks,
  ) {
    this.members = [{ id: transport.selfId, name: cleanName(hostName), key: '', peer: transport.selfId }];
    transport.setHandlers({
      message: (from, _ch, data) => this.onMessage(from, data),
      peerOpen: () => {
        /* wait for their hello */
      },
      peerClose: (peer) => this.peerGone(peer),
    });
  }

  /** New connections are always heard: during a game, players may be coming back. */
  get accepting(): boolean {
    return true;
  }

  get players(): LobbyPlayer[] {
    return this.members.map((m) => ({ id: m.id, name: m.name }));
  }

  /** Player ids whose device is disconnected right now. */
  get offline(): string[] {
    return this.members.filter((m) => m.peer === null).map((m) => m.id);
  }

  /** The host changes their own name in the lobby. */
  rename(name: string): void {
    const me = this.members[0];
    if (!me) return;
    me.name = uniqueName(name, this.members, me.id);
    this.publishLobby();
  }

  /** Starts (or restarts) a game with everyone connected; bots fill the rest. */
  start(difficulty: Difficulty, seed: number, scores: ReadonlyMap<string, number> = new Map()): HostSession {
    this.game?.session.dispose();
    // People who left before this game starts are not kept.
    this.members = this.members.filter((m) => m.peer !== null);
    const setups: PlayerSetup[] = this.members.map((p) => ({ id: p.id, name: p.name, isBot: false, score: scores.get(p.id) ?? 0 }));
    for (let i = 1; setups.length < CONFIG.maxPlayers; i++) {
      const id = `bot${i}`;
      setups.push({ id, name: botName(i), isBot: true, score: scores.get(id) ?? 0 });
    }
    const session = new HostSession(this.transport, setups, seed, difficulty, () => this.peerIds(), () => this.offline);
    this.game = { session, seed, setups, difficulty };
    this.broadcast('reliable', { t: 'start', seed, players: setups, difficulty });
    this.publishLobby();
    return session;
  }

  /** Back to the lobby after a game; late joiners can enter again. */
  endGame(): void {
    this.game?.session.dispose();
    this.game = null;
  }

  close(): void {
    this.broadcast('reliable', { t: 'bye', reason: 'closed' });
    this.game?.session.dispose();
    this.transport.close();
  }

  /** Connections to send to: everyone else who is connected. */
  private peerIds(): string[] {
    return this.members.filter((m) => m.peer !== null && m.peer !== this.transport.selfId).map((m) => m.peer as string);
  }

  private byPeer(peer: string): Member | undefined {
    return this.members.find((m) => m.peer === peer);
  }

  private onMessage(from: string, data: string): void {
    const msg = parseClientMsg(data);
    if (!msg) return;
    if (msg.t === 'hello') return this.hello(from, msg.v, msg.name, msg.k);
    const member = this.byPeer(from);
    if (!member) return;
    if (msg.t === 'bye') return this.peerGone(from);
    this.game?.session.receive(member.id, msg);
  }

  private hello(from: string, version: number, name: string, key: string): void {
    if (version !== PROTOCOL_VERSION) return this.send(from, 'reliable', { t: 'reject', reason: 'version' });

    // Same connection says hello again: a name change.
    const current = this.byPeer(from);
    if (current) {
      current.name = uniqueName(name, this.members, current.id);
      this.publishLobby();
      return;
    }

    // A known device coming back (after quitting, a crash or a dropped network).
    const returning = key ? this.members.find((m) => m.key === key && m.id !== this.transport.selfId) : undefined;
    if (returning) {
      const old = returning.peer;
      returning.peer = from;
      if (!this.game) returning.name = uniqueName(name, this.members, returning.id);
      if (old && old !== from) this.transport.send(old, 'reliable', JSON.stringify({ t: 'bye', reason: 'left' } satisfies HostMsg));
      this.send(from, 'reliable', { t: 'welcome', v: PROTOCOL_VERSION, id: returning.id });
      if (this.game) {
        const g = this.game;
        this.send(from, 'reliable', { t: 'start', seed: g.seed, players: g.setups, difficulty: g.difficulty });
        g.session.peerBack(returning.id);
      }
      this.publishLobby();
      return;
    }

    if (this.game) return this.send(from, 'reliable', { t: 'reject', reason: 'started' });
    if (this.members.length >= CONFIG.maxPlayers) return this.send(from, 'reliable', { t: 'reject', reason: 'full' });
    this.members.push({ id: from, name: uniqueName(name, this.members, from), key, peer: from });
    this.send(from, 'reliable', { t: 'welcome', v: PROTOCOL_VERSION, id: from });
    this.publishLobby();
  }

  /** A connection closed or said bye. */
  private peerGone(peer: string): void {
    const member = this.byPeer(peer);
    if (!member || member.id === this.transport.selfId) return;
    const inGame = this.game?.setups.some((s) => s.id === member.id) ?? false;
    if (inGame) {
      // Keep their place and character; they can come back.
      member.peer = null;
      this.game?.session.peerLeft(member.id);
    } else {
      this.members = this.members.filter((m) => m !== member);
    }
    this.publishLobby();
  }

  private publishLobby(): void {
    this.broadcast('reliable', { t: 'lobby', players: this.players });
    this.cb.lobby(this.players);
  }

  private broadcast(channel: Channel, msg: HostMsg): void {
    const data = JSON.stringify(msg);
    for (const peer of this.peerIds()) this.transport.send(peer, channel, data);
  }

  private send(to: string, channel: Channel, msg: HostMsg): void {
    this.transport.send(to, channel, JSON.stringify(msg));
  }
}

interface RemoteInput {
  x: number;
  z: number;
  seq: number;
  action: boolean;
}

/** The authoritative game on the host device. The host also plays. */
export class HostSession implements GameSession {
  readonly kind = 'host';
  readonly humanId: string;
  private readonly sim: Simulation;
  private readonly remote = new Map<string, RemoteInput>();
  private localAction = false;
  private snapTimer = 0;
  private disposed = false;

  constructor(
    private readonly transport: Transport,
    setups: readonly PlayerSetup[],
    seed: number,
    difficulty: Difficulty,
    private readonly peerIds: () => string[],
    private readonly offlineIds: () => string[],
  ) {
    this.humanId = transport.selfId;
    this.sim = new Simulation(setups, seed, difficulty);
  }

  get state(): GameState {
    return this.sim.state;
  }

  /** Input from a player (already mapped from connection to player id). */
  receive(playerId: string, msg: { t: 'in'; s: number; x: number; z: number } | { t: 'act'; s: number }): void {
    const r = this.remote.get(playerId) ?? { x: 0, z: 0, seq: -1, action: false };
    if (msg.t === 'act') r.action = true;
    else if (msg.s > r.seq) {
      // Older packets on the unordered channel are ignored.
      r.seq = msg.s;
      r.x = msg.x;
      r.z = msg.z;
    }
    this.remote.set(playerId, r);
  }

  /** The player's device dropped out: their character stands still (no bot takes over). */
  peerLeft(playerId: string): void {
    this.remote.delete(playerId);
  }

  /** The player is back on a new connection; input numbering starts over. */
  peerBack(playerId: string): void {
    this.remote.delete(playerId);
    this.snapTimer = SNAP_INTERVAL; // send them a snapshot right away
  }

  offline(): ReadonlySet<string> {
    return new Set(this.offlineIds());
  }

  update(dt: number, input: PlayerInput): GameEvent[] {
    if (this.disposed) return [];
    this.localAction ||= input.action;
    const events = this.sim.advance(dt, (id, first) => {
      if (id === this.humanId) {
        const action = first && this.localAction;
        if (action) this.localAction = false;
        return { moveX: input.moveX, moveZ: input.moveZ, action };
      }
      const r = this.remote.get(id);
      if (!r) return { moveX: 0, moveZ: 0, action: false };
      const action = first && r.action;
      if (action) r.action = false;
      return { moveX: r.x, moveZ: r.z, action };
    });

    if (events.length > 0) this.broadcast('reliable', JSON.stringify({ t: 'ev', e: events } satisfies HostMsg));
    this.snapTimer += dt;
    if (this.snapTimer >= SNAP_INTERVAL || events.length > 0) {
      this.snapTimer = 0;
      this.broadcast('fast', JSON.stringify({ t: 'snap', s: packSnapshot(this.sim.state, this.offlineIds(), this.acks()) } satisfies HostMsg));
    }
    return events;
  }

  private acks(): Array<[string, number]> {
    return [...this.remote].filter(([, r]) => r.seq >= 0).map(([id, r]) => [id, r.seq]);
  }

  view(): GameState {
    return this.sim.view();
  }

  dispose(): void {
    this.disposed = true;
  }

  private broadcast(channel: Channel, data: string): void {
    for (const peer of this.peerIds()) this.transport.send(peer, channel, data);
  }
}

import { CONFIG } from '../core/config';
import type { GameEvent, GameState, PlayerInput, PlayerSetup } from '../core/types';
import { Simulation, type Difficulty, type GameSession } from '../session/session';
import { cleanName, MAX_NAME, packSnapshot, parseClientMsg, PROTOCOL_VERSION, type HostMsg, type LobbyPlayer } from './protocol';
import type { Channel, Transport } from './transport';

const SNAP_INTERVAL = 1 / 20;
export const BOT_NAMES = ['Budi', 'Sari', 'Dimas', 'Rina', 'Agus', 'Wulan'];

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
 * The host owns the room: it admits players, starts games and runs the
 * authoritative simulation. Other devices only send input.
 */
export class HostNet {
  private lobbyPlayers: LobbyPlayer[];
  private session: HostSession | null = null;

  constructor(
    private readonly transport: Transport,
    hostName: string,
    private readonly cb: HostCallbacks,
  ) {
    this.lobbyPlayers = [{ id: transport.selfId, name: cleanName(hostName) }];
    transport.setHandlers({
      message: (from, _ch, data) => this.onMessage(from, data),
      peerOpen: () => {
        /* wait for their hello */
      },
      peerClose: (id) => this.dropPeer(id),
    });
  }

  /** Whether a new device may connect right now. */
  get accepting(): boolean {
    return !this.session && this.lobbyPlayers.length < CONFIG.maxPlayers;
  }

  get players(): LobbyPlayer[] {
    return [...this.lobbyPlayers];
  }

  /** The host changes their own name in the lobby. */
  rename(name: string): void {
    const me = this.lobbyPlayers[0];
    if (!me) return;
    me.name = uniqueName(name, this.lobbyPlayers, me.id);
    this.publishLobby();
  }

  /** Starts (or restarts) a game with everyone in the lobby; bots fill the rest. */
  start(difficulty: Difficulty, seed: number): HostSession {
    this.session?.dispose();
    const taken = new Set(this.lobbyPlayers.map((p) => p.name));
    const botNames = BOT_NAMES.filter((n) => !taken.has(n));
    const setups: PlayerSetup[] = this.lobbyPlayers.map((p) => ({ id: p.id, name: p.name, isBot: false }));
    for (let i = 1; setups.length < CONFIG.maxPlayers; i++) {
      setups.push({ id: `bot${i}`, name: botNames[(seed + i) % botNames.length] ?? `Bot ${i}`, isBot: true });
    }
    this.broadcast('reliable', { t: 'start', seed, players: setups, difficulty });
    this.session = new HostSession(this.transport, setups, seed, difficulty, () => this.peerIds());
    return this.session;
  }

  /** Back to the lobby after a game; late joiners can enter again. */
  endGame(): void {
    this.session?.dispose();
    this.session = null;
  }

  close(): void {
    this.broadcast('reliable', { t: 'bye', reason: 'closed' });
    this.session?.dispose();
    this.transport.close();
  }

  private peerIds(): string[] {
    return this.lobbyPlayers.map((p) => p.id).filter((id) => id !== this.transport.selfId);
  }

  private onMessage(from: string, data: string): void {
    const msg = parseClientMsg(data);
    if (!msg) return;
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) return this.send(from, 'reliable', { t: 'reject', reason: 'version' });
      if (this.session) return this.send(from, 'reliable', { t: 'reject', reason: 'started' });
      const known = this.lobbyPlayers.find((p) => p.id === from);
      if (!known && this.lobbyPlayers.length >= CONFIG.maxPlayers) return this.send(from, 'reliable', { t: 'reject', reason: 'full' });
      // A second hello from a known player is a name change.
      if (known) known.name = uniqueName(msg.name, this.lobbyPlayers, from);
      else this.lobbyPlayers.push({ id: from, name: uniqueName(msg.name, this.lobbyPlayers, from) });
      this.send(from, 'reliable', { t: 'welcome', v: PROTOCOL_VERSION, id: from });
      this.publishLobby();
      return;
    }
    if (msg.t === 'bye') return this.dropPeer(from);
    this.session?.receive(from, msg);
  }

  private dropPeer(id: string): void {
    const was = this.lobbyPlayers.length;
    this.lobbyPlayers = this.lobbyPlayers.filter((p) => p.id !== id);
    this.session?.peerLeft(id);
    if (this.lobbyPlayers.length !== was) this.publishLobby();
  }

  private publishLobby(): void {
    this.broadcast('reliable', { t: 'lobby', players: this.lobbyPlayers });
    this.cb.lobby(this.players);
  }

  private broadcast(channel: Channel, msg: HostMsg): void {
    const data = JSON.stringify(msg);
    for (const id of this.peerIds()) this.transport.send(id, channel, data);
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
  ) {
    this.humanId = transport.selfId;
    this.sim = new Simulation(setups, seed, difficulty);
  }

  get state(): GameState {
    return this.sim.state;
  }

  receive(from: string, msg: { t: 'in'; s: number; x: number; z: number } | { t: 'act'; s: number }): void {
    const r = this.remote.get(from) ?? { x: 0, z: 0, seq: -1, action: false };
    if (msg.t === 'act') r.action = true;
    else if (msg.s > r.seq) {
      // Older packets on the unordered channel are ignored.
      r.seq = msg.s;
      r.x = msg.x;
      r.z = msg.z;
    }
    this.remote.set(from, r);
  }

  peerLeft(id: string): void {
    this.remote.delete(id);
    this.sim.makeBot(id);
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
      this.broadcast('fast', JSON.stringify({ t: 'snap', s: packSnapshot(this.sim.state) } satisfies HostMsg));
    }
    return events;
  }

  view(): GameState {
    return this.sim.view();
  }

  dispose(): void {
    this.disposed = true;
  }

  private broadcast(channel: Channel, data: string): void {
    for (const id of this.peerIds()) this.transport.send(id, channel, data);
  }
}


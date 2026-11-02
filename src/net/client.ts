import { constrainToCar, createGame, move } from '../core/game';
import type { GameEvent, GameState, Player, PlayerInput, PlayerSetup, Vec2 } from '../core/types';
import { withPositions, type GameSession } from '../session/session';
import { applySnapshot, parseHostMsg, PROTOCOL_VERSION, type ClientMsg, type LobbyPlayer, type RejectReason, type Snapshot } from './protocol';
import type { Transport } from './transport';

/** How far behind the newest snapshot other players are drawn (seconds). */
const INTERP_DELAY = 0.12;
const INPUT_INTERVAL = 1 / 30;

export type CloseReason = RejectReason | 'hostLeft' | 'timeout';

export interface ClientCallbacks {
  lobby(players: LobbyPlayer[]): void;
  start(session: ClientSession): void;
  closed(reason: CloseReason): void;
}

/** Connection to a host, from the lobby through any number of games. */
export class ClientNet {
  private myId: string | null = null;
  private session: ClientSession | null = null;
  private done = false;

  /** `hostId` may be null when the host is only known once it connects. */
  constructor(
    private readonly transport: Transport,
    private hostId: string | null,
    private readonly name: string,
    private readonly cb: ClientCallbacks,
  ) {
    transport.setHandlers({
      message: (from, _ch, data) => {
        if (from === this.hostId) this.onMessage(data);
      },
      peerOpen: (id) => {
        this.hostId ??= id;
        if (id === this.hostId) this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name });
      },
      peerClose: (id) => {
        if (id === this.hostId) this.finish('hostLeft');
      },
    });
    if (hostId && transport.peers().includes(hostId)) this.send({ t: 'hello', v: PROTOCOL_VERSION, name });
  }

  get id(): string | null {
    return this.myId;
  }

  leave(): void {
    this.send({ t: 'bye' });
    this.done = true;
    this.transport.close();
  }

  private onMessage(data: string): void {
    const msg = parseHostMsg(data);
    if (!msg) return;
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        break;
      case 'reject':
        this.finish(msg.reason);
        break;
      case 'lobby':
        this.cb.lobby(msg.players);
        break;
      case 'start':
        if (!this.myId) return;
        this.session?.dispose();
        this.session = new ClientSession(this.myId, msg.players, msg.seed, (m) => this.send(m));
        this.cb.start(this.session);
        break;
      case 'snap':
        this.session?.receiveSnapshot(msg.s);
        break;
      case 'ev':
        this.session?.receiveEvents(msg.e);
        break;
      case 'bye':
        this.finish('hostLeft');
        break;
    }
  }

  private finish(reason: CloseReason): void {
    if (this.done) return;
    this.done = true;
    this.session?.dispose();
    this.transport.close();
    this.cb.closed(reason);
  }

  private send(msg: ClientMsg): void {
    if (!this.hostId) return;
    const channel = msg.t === 'in' ? 'fast' : 'reliable';
    this.transport.send(this.hostId, channel, JSON.stringify(msg));
  }
}

interface Buffered {
  snap: Snapshot;
  at: number; // local clock when received
}

/**
 * A game simulated on the host. Draws other players slightly in the past
 * (interpolated between snapshots) and predicts our own movement so the
 * stick feels instant, gently correcting towards the host.
 */
export class ClientSession implements GameSession {
  readonly kind = 'client';
  private readonly state: GameState;
  private readonly snaps: Buffered[] = [];
  private events: GameEvent[] = [];
  private clock = 0;
  private offset: number | null = null; // host time - local clock
  private seq = 0;
  private lastSent = { x: 0, z: 0, at: -1 };
  private readonly me: Player;
  private disposed = false;

  constructor(
    readonly humanId: string,
    setups: readonly PlayerSetup[],
    seed: number,
    private readonly sendMsg: (m: ClientMsg) => void,
  ) {
    this.state = createGame(setups, seed);
    const me = this.state.players.find((p) => p.id === humanId);
    if (!me) throw new Error('Host did not include this player');
    this.me = { ...me, pos: { ...me.pos }, vel: { ...me.vel } };
  }

  receiveSnapshot(snap: Snapshot): void {
    const latest = this.snaps[this.snaps.length - 1];
    if (latest && snap.time <= latest.snap.time) return; // out of order
    this.snaps.push({ snap, at: this.clock });
    if (this.snaps.length > 30) this.snaps.shift();
    const off = snap.time - this.clock;
    // Track the host clock; follow faster when it jumps ahead (we were late).
    this.offset = this.offset === null || off > this.offset + 0.25 ? off : this.offset + (off - this.offset) * 0.1;
    applySnapshot(this.state, snap);
  }

  receiveEvents(events: GameEvent[]): void {
    this.events.push(...events);
  }

  private hostNow(): number {
    return this.offset === null ? this.state.time : this.clock + this.offset;
  }

  update(dt: number, input: PlayerInput): GameEvent[] {
    if (this.disposed) return [];
    this.clock += dt;
    this.sendInput(input);
    this.predict(dt, input);
    const out = this.events;
    this.events = [];
    return out;
  }

  private sendInput(input: PlayerInput): void {
    if (input.action) this.sendMsg({ t: 'act', s: ++this.seq });
    const changed = Math.abs(input.moveX - this.lastSent.x) > 0.05 || Math.abs(input.moveZ - this.lastSent.z) > 0.05;
    if (changed || this.clock - this.lastSent.at >= INPUT_INTERVAL) {
      this.sendMsg({ t: 'in', s: ++this.seq, x: round2(input.moveX), z: round2(input.moveZ) });
      this.lastSent = { x: input.moveX, z: input.moveZ, at: this.clock };
    }
  }

  private predict(dt: number, input: PlayerInput): void {
    const server = this.state.players.find((p) => p.id === this.humanId);
    if (!server) return;
    const me = this.me;
    me.seatId = server.seatId;
    me.eliminated = server.eliminated;
    me.stunnedUntil = server.stunnedUntil;
    const active = (this.state.phase === 'riding' || this.state.phase === 'scramble') && server.seatId === null && !server.eliminated;
    if (!active || this.snaps.length === 0) {
      me.pos = { ...server.pos };
      me.vel = { ...server.vel };
      me.facing = server.facing;
      return;
    }
    const now = this.hostNow();
    move({ ...this.state, time: now }, me, input, dt);
    constrainToCar(me);

    // Where the host probably has us now: last known position moved on by its velocity.
    const latest = this.snaps[this.snaps.length - 1]!;
    const lag = Math.max(0, Math.min(0.3, now - latest.snap.time));
    const target: Vec2 = { x: server.pos.x + server.vel.x * lag, z: server.pos.z + server.vel.z * lag };
    const ex = target.x - me.pos.x;
    const ez = target.z - me.pos.z;
    const err = Math.hypot(ex, ez);
    if (err > 1.5) {
      me.pos = target;
      me.vel = { ...server.vel };
    } else {
      const stunned = now < server.stunnedUntil;
      const k = 1 - Math.exp(-(stunned ? 14 : 3.5) * dt);
      me.pos.x += ex * k;
      me.pos.z += ez * k;
    }
  }

  view(): GameState {
    const now = this.hostNow();
    const renderAt = now - INTERP_DELAY;
    const view = withPositions(this.state, (p) => {
      if (p.id === this.humanId) return this.me.pos;
      return this.interpolated(p.id, renderAt) ?? p.pos;
    });
    view.time = Math.max(this.state.time, Math.min(now, this.state.time + 0.5));
    const me = view.players.find((p) => p.id === this.humanId);
    if (me && me.seatId === null) me.facing = this.me.facing;
    return view;
  }

  private interpolated(id: string, t: number): Vec2 | null {
    const s = this.snaps;
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1]!.snap;
      const b = s[i]!.snap;
      if (a.time <= t && t <= b.time) {
        const ra = a.p.find((r) => r[0] === id);
        const rb = b.p.find((r) => r[0] === id);
        if (!ra || !rb) return null;
        if (rb[6] >= 0 || ra[6] !== rb[6] || Math.hypot(rb[1] - ra[1], rb[2] - ra[2]) > 1.5) return { x: rb[1], z: rb[2] };
        const k = (t - a.time) / Math.max(1e-6, b.time - a.time);
        return { x: ra[1] + (rb[1] - ra[1]) * k, z: ra[2] + (rb[2] - ra[2]) * k };
      }
    }
    return null;
  }

  dispose(): void {
    this.disposed = true;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

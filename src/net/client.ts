import { keepOutOfStanders } from '../core/challenges';
import { constrainToCar, createGame, move } from '../core/game';
import type { GameEvent, GameState, Player, PlayerInput, PlayerSetup, Vec2 } from '../core/types';
import { withPositions, type GameSession } from '../session/session';
import { applySnapshot, parseHostMsg, PROTOCOL_VERSION, type ClientMsg, type LobbyPlayer, type RejectReason, type Snapshot } from './protocol';
import type { Transport } from './transport';

/** How far behind the newest snapshot other players are drawn (seconds). */
const INTERP_DELAY = 0.12;
/** Movement input goes out about every frame (60 Hz) so the host can acknowledge it precisely. */
const INPUT_INTERVAL = 1 / 75;
/** Longest stretch of unacknowledged input we replay (seconds of frames). */
const MAX_HISTORY = 240;

/**
 * `lost`: the link to the host dropped or went silent (bad signal), but the
 * host did not say goodbye, so the game is probably still running there.
 */
export type CloseReason = RejectReason | 'hostLeft' | 'timeout' | 'unreachable' | 'lost';

/** No word from the host for this long during a game means the link is dead. */
const SILENCE_MS = 4000;

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
  private lastHeard = Date.now();
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly onVisible = () => {
    // Timers sleep in the background; give the link a fresh chance when we are back.
    if (typeof document === 'undefined' || !document.hidden) this.lastHeard = Date.now();
  };

  /** `hostId` may be null when the host is only known once it connects. */
  constructor(
    private readonly transport: Transport,
    private hostId: string | null,
    private name: string,
    private readonly key: string,
    private readonly cb: ClientCallbacks,
  ) {
    transport.setHandlers({
      message: (from, _ch, data) => {
        if (from !== this.hostId) return;
        this.lastHeard = Date.now();
        this.onMessage(data);
      },
      peerOpen: (id) => {
        this.hostId ??= id;
        if (id === this.hostId) this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, k: this.key });
      },
      peerClose: (id) => {
        if (id === this.hostId) this.finish('lost');
      },
    });
    // During a game the host sends 20 snapshots a second; silence means a dead link.
    this.watchdog = setInterval(() => {
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (this.session && !hidden && Date.now() - this.lastHeard > SILENCE_MS) this.finish('lost');
    }, 1000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    if (hostId && transport.peers().includes(hostId)) this.send({ t: 'hello', v: PROTOCOL_VERSION, name, k: key });
  }

  get id(): string | null {
    return this.myId;
  }

  /** Changes our name in the lobby (the host treats a repeated hello as a rename). */
  rename(name: string): void {
    this.name = name;
    if (this.myId) this.send({ t: 'hello', v: PROTOCOL_VERSION, name, k: this.key });
  }

  leave(): void {
    this.send({ t: 'bye' });
    this.done = true;
    this.stopWatching();
    this.transport.close();
  }

  private stopWatching(): void {
    clearInterval(this.watchdog);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
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
        this.lastHeard = Date.now();
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
    this.stopWatching();
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

interface Frame {
  seq: number; // last movement seq sent when this frame ran
  dt: number;
  input: PlayerInput;
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
  private moveSeq = -1;
  private history: Frame[] = [];
  private reconciledAt = -1; // host time of the snapshot we last reconciled with
  /** Visual-only offset that hides small corrections; fades out quickly. */
  private smooth: Vec2 = { x: 0, z: 0 };
  private readonly me: Player;
  private offlineSet: ReadonlySet<string> = new Set();
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

  /** True once the host's state has arrived (before that the view is only the opening layout). */
  get hasSnapshot(): boolean {
    return this.snaps.length > 0;
  }

  /** Nothing from the host for a moment: the game on screen is not moving on (weak signal). */
  get stalled(): boolean {
    const latest = this.snaps[this.snaps.length - 1];
    return !!latest && this.state.phase !== 'gameOver' && this.clock - latest.at > 0.6;
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
    this.offlineSet = new Set(snap.off);
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
      this.moveSeq = ++this.seq;
      this.sendMsg({ t: 'in', s: this.moveSeq, x: round2(input.moveX), z: round2(input.moveZ) });
      this.lastSent = { x: input.moveX, z: input.moveZ, at: this.clock };
    }
  }

  /**
   * Client-side prediction with reconciliation: the host tells us the last
   * input it applied, so on every snapshot we restart from the host's position
   * and replay only the inputs it has not seen yet. Under real latency (phone
   * networks, Safari on Wi-Fi) the stick stays responsive instead of being
   * pulled back towards where the host saw us a moment ago.
   */
  private predict(dt: number, input: PlayerInput): void {
    const server = this.state.players.find((p) => p.id === this.humanId);
    if (!server) return;
    const me = this.me;
    me.seatId = server.seatId;
    me.eliminated = server.eliminated;
    me.stunnedUntil = server.stunnedUntil;
    me.shieldUntil = server.shieldUntil;
    me.sleeping = server.sleeping;
    const active = (this.state.phase === 'riding' || this.state.phase === 'scramble') && server.seatId === null && !server.eliminated;
    const latest = this.snaps[this.snaps.length - 1];
    if (!active || !latest) {
      me.pos = { ...server.pos };
      me.vel = { ...server.vel };
      me.facing = server.facing;
      this.history = [];
      this.smooth = { x: 0, z: 0 };
      return;
    }
    this.history.push({ seq: this.moveSeq, dt, input: { moveX: input.moveX, moveZ: input.moveZ, action: false } });
    if (this.history.length > MAX_HISTORY) this.history.shift();

    const ack = latest.snap.ack.find((a) => a[0] === this.humanId)?.[1];
    if (latest.snap.time !== this.reconciledAt && ack !== undefined) {
      this.reconciledAt = latest.snap.time;
      const before = { ...me.pos };
      // Inputs up to `ack` are already inside the host's position.
      this.history = this.history.filter((f) => f.seq > ack);
      me.pos = { ...server.pos };
      me.vel = { ...server.vel };
      let t = latest.snap.time;
      for (const f of this.history) {
        t += f.dt;
        this.step(me, f.input, f.dt, t);
      }
      const ex = before.x + this.smooth.x - me.pos.x;
      const ez = before.z + this.smooth.z - me.pos.z;
      // Big jumps (pushed, teleported to a seat) are shown as they are.
      this.smooth = Math.hypot(ex, ez) > 1.5 ? { x: 0, z: 0 } : { x: ex, z: ez };
    } else {
      this.step(me, input, dt, this.hostNow());
      if (ack === undefined) this.pullTowards(server, dt); // host without acks yet
    }
    const k = Math.exp(-12 * dt);
    this.smooth.x *= k;
    this.smooth.z *= k;
  }

  private step(me: Player, input: PlayerInput, dt: number, time: number): void {
    const predicted = { ...this.state, time };
    move(predicted, me, input, dt);
    keepOutOfStanders(predicted, me);
    constrainToCar(me);
  }

  /** Fallback correction when no acknowledgement is available. */
  private pullTowards(server: Player, dt: number): void {
    const me = this.me;
    const ex = server.pos.x - me.pos.x;
    const ez = server.pos.z - me.pos.z;
    if (Math.hypot(ex, ez) > 1.5) {
      me.pos = { ...server.pos };
      return;
    }
    const k = 1 - Math.exp(-3.5 * dt);
    me.pos.x += ex * k;
    me.pos.z += ez * k;
  }

  offline(): ReadonlySet<string> {
    return this.offlineSet;
  }

  view(): GameState {
    const now = this.hostNow();
    const renderAt = now - INTERP_DELAY;
    const view = withPositions(this.state, (p) => {
      if (p.id === this.humanId) return { x: this.me.pos.x + this.smooth.x, z: this.me.pos.z + this.smooth.z };
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

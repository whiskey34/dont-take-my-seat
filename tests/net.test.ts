import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/core/config';
import { createGame, step } from '../src/core/game';
import { ClientNet, type ClientSession, type CloseReason } from '../src/net/client';
import { HostNet, uniqueName } from '../src/net/host';
import { applySnapshot, packSnapshot, parseClientMsg, parseHostMsg } from '../src/net/protocol';
import { HandlerSlot, type Channel, type Transport, type TransportHandlers } from '../src/net/transport';
import { NO_INPUT } from '../src/core/types';

/** In-memory network: a hub that delivers messages on the next pump. */
class Hub {
  private items: Array<{ fn: () => void; due: number }> = [];
  private tick = 0;
  dropFast = 0;
  /** Extra one-way delay, in pumps. */
  latency = 0;
  rng = 1;
  readonly queue = { push: (fn: () => void) => this.items.push({ fn, due: this.tick + 1 + this.latency }) };
  pump(): void {
    this.tick++;
    const now = this.items.filter((i) => i.due <= this.tick);
    this.items = this.items.filter((i) => i.due > this.tick);
    now.forEach((i) => i.fn());
  }
  random(): number {
    this.rng = (this.rng * 16807) % 2147483647;
    return this.rng / 2147483647;
  }
}

class FakeTransport implements Transport {
  readonly slot = new HandlerSlot();
  links = new Map<string, FakeTransport>();
  closed = false;
  constructor(
    readonly selfId: string,
    private readonly hub: Hub,
  ) {}
  static connect(a: FakeTransport, b: FakeTransport): void {
    a.links.set(b.selfId, b);
    b.links.set(a.selfId, a);
    a.hub.queue.push(() => {
      a.slot.peerOpen(b.selfId);
      b.slot.peerOpen(a.selfId);
    });
  }
  peers(): string[] {
    return [...this.links.keys()];
  }
  send(to: string, channel: Channel, data: string): void {
    const peer = this.links.get(to);
    if (!peer || this.closed) return;
    if (channel === 'fast' && this.hub.random() < this.hub.dropFast) return;
    this.hub.queue.push(() => peer.slot.message(this.selfId, channel, data));
  }
  setHandlers(h: TransportHandlers): void {
    this.slot.set(h);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of this.links.values()) {
      peer.links.delete(this.selfId);
      this.hub.queue.push(() => peer.slot.peerClose(this.selfId));
    }
    this.links.clear();
  }
}

function setupRoom(dropFast = 0) {
  const hub = new Hub();
  hub.dropFast = dropFast;
  const hostT = new FakeTransport('H', hub);
  const lobbies: string[][] = [];
  const host = new HostNet(hostT, 'Host', { lobby: (p) => lobbies.push(p.map((x) => x.name)) });
  const clients = ['A', 'B'].map((id) => {
    const t = new FakeTransport(id, hub);
    FakeTransport.connect(hostT, t);
    const rec = { session: null as ClientSession | null, closed: null as CloseReason | null, t };
    const net = new ClientNet(t, 'H', `Player ${id}`, `key-of-${id}`, {
      lobby: () => {},
      start: (s) => (rec.session = s),
      closed: (r) => (rec.closed = r),
    });
    return { ...rec, net, rec };
  });
  for (let i = 0; i < 5; i++) hub.pump();
  return { hub, host, hostT, clients, lobbies };
}

describe('protocol', () => {
  it('round-trips a snapshot', () => {
    const setups = ['a', 'b', 'c'].map((id) => ({ id, name: id, isBot: true }));
    const g = createGame(setups, 5);
    for (let i = 0; i < 60 * 8; i++) step(g, new Map(), 1 / 60);
    const copy = createGame(setups, 99);
    const msg = parseHostMsg(JSON.stringify({ t: 'snap', s: packSnapshot(g) }));
    expect(msg?.t).toBe('snap');
    if (msg?.t !== 'snap') return;
    applySnapshot(copy, msg.s);
    expect(copy.phase).toBe(g.phase);
    expect(copy.freeSeatIds).toEqual(g.freeSeatIds);
    expect(copy.seats.map((s) => s.npc)).toEqual(g.seats.map((s) => s.npc));
    expect(copy.players[0]!.pos.x).toBeCloseTo(g.players[0]!.pos.x, 2);
  });

  it('carries challenges, standing passengers and power-ups', () => {
    const setups = ['a', 'b', 'c'].map((id) => ({ id, name: id, isBot: true }));
    for (let seed = 1; seed < 40; seed++) {
      const g = createGame(setups, seed);
      for (let i = 0; i < 60 * 7; i++) step(g, new Map(), 1 / 60); // into the scramble
      g.players[1]!.sleeping = true;
      g.players[2]!.shieldUntil = g.time + 2;
      const copy = createGame(setups, 999);
      const msg = parseHostMsg(JSON.stringify({ t: 'snap', s: packSnapshot(g) }));
      if (msg?.t !== 'snap') throw new Error('snapshot rejected');
      applySnapshot(copy, msg.s);
      expect(copy.challenge).toBe(g.challenge);
      expect(copy.doorSide).toBe(g.doorSide);
      expect(copy.standers.map((x) => x.id)).toEqual(g.standers.map((x) => x.id));
      expect(copy.powerUps.map((x) => x.kind)).toEqual(g.powerUps.map((x) => x.kind));
      expect(copy.players[1]!.sleeping).toBe(true);
      expect(copy.players[2]!.shieldUntil).toBeCloseTo(g.players[2]!.shieldUntil, 2);
    }
    expect(parseHostMsg(JSON.stringify({ t: 'ev', e: [{ type: 'powerUp', playerId: 'a', kind: 'rocket' }] }))).toBeNull();
  });

  it('rejects malformed and hostile messages', () => {
    expect(parseClientMsg('not json')).toBeNull();
    expect(parseClientMsg('{"t":"in","s":1,"x":"1","z":0}')).toBeNull();
    expect(parseClientMsg('{"t":"nope"}')).toBeNull();
    expect(parseClientMsg('x'.repeat(70_000))).toBeNull();
    expect(parseClientMsg('{"t":"in","s":1,"x":50,"z":-50}')).toEqual({ t: 'in', s: 1, x: 1, z: -1 });
    expect(parseClientMsg('{"t":"hello","v":1,"name":"  \\u0000Budi\\u0007 the longest name ever "}')).toEqual({ t: 'hello', v: 1, name: 'Budi the longe', k: '' });
    expect(parseClientMsg('{"t":"hello","v":3,"name":"A","k":"abc"}')).toMatchObject({ k: '' }); // too short to be a key
    expect(parseClientMsg('{"t":"hello","v":3,"name":"A","k":"0123456789abcdef"}')).toMatchObject({ k: '0123456789abcdef' });
    expect(parseHostMsg('{"t":"ev","e":[{"type":"hack"}]}')).toBeNull();
    expect(parseHostMsg('{"t":"start","seed":1,"players":[{"id":"a","isBot":false}]}')).toBeNull();
  });
});

describe('host and clients', () => {
  it('admits players into the lobby and refuses a fifth', () => {
    const { hub, host, hostT, lobbies } = setupRoom();
    expect(host.players.map((p) => p.name)).toEqual(['Host', 'Player A', 'Player B']);
    expect(lobbies.at(-1)).toEqual(['Host', 'Player A', 'Player B']);
    const c = new FakeTransport('C', hub);
    FakeTransport.connect(hostT, c);
    new ClientNet(c, 'H', 'C', 'key-of-C', { lobby: () => {}, start: () => {}, closed: () => {} });
    const d = new FakeTransport('D', hub);
    FakeTransport.connect(hostT, d);
    let reason: CloseReason | null = null;
    new ClientNet(d, 'H', 'D', 'key-of-D', { lobby: () => {}, start: () => {}, closed: (r) => (reason = r) });
    for (let i = 0; i < 5; i++) hub.pump();
    expect(host.players).toHaveLength(CONFIG.maxPlayers);
    expect(reason).toBe('full');
  });

  it('renames players live and keeps names unique', () => {
    const { hub, host, clients, lobbies } = setupRoom();
    clients[0]!.net.rename('Player B'); // same as B: becomes "Player B 2"
    hub.pump();
    hub.pump();
    expect(host.players.map((p) => p.name)).toEqual(['Host', 'Player B 2', 'Player B']);
    host.rename('delfino');
    hub.pump();
    expect(lobbies.at(-1)).toEqual(['delfino', 'Player B 2', 'Player B']);
    expect(uniqueName('  Andi  ', [{ id: 'x', name: 'andi' }], 'me')).toBe('Andi 2');
    expect(uniqueName('Penumpang Kereta', [{ id: 'x', name: 'Penumpang Kere' }], 'me')).toBe('Penumpang Ke 2');
  });

  it('plays a full game; clients see the same result as the host, even with 30% fast-packet loss', () => {
    const { hub, host, clients } = setupRoom(0.3);
    const session = host.start('normal', 1234);
    for (let i = 0; i < 3; i++) hub.pump();
    expect(clients.every((c) => c.rec.session)).toBe(true);
    const dt = 1 / 60;
    for (let tick = 0; tick < 60 * 120 && session.state.phase !== 'gameOver'; tick++) {
      session.update(dt, NO_INPUT);
      for (const c of clients) c.rec.session!.update(dt, NO_INPUT);
      hub.pump();
    }
    for (let i = 0; i < 30; i++) {
      session.update(1 / 60, NO_INPUT);
      hub.pump();
    }
    expect(session.state.phase).toBe('gameOver');
    for (const c of clients) {
      const view = c.rec.session!.view();
      expect(view.phase).toBe('gameOver');
      expect(view.winnerId).toBe(session.state.winnerId);
      expect(view.players.map((p) => p.eliminated)).toEqual(session.state.players.map((p) => p.eliminated));
    }
  });

  it('a remote player can move and sit through the host', () => {
    const { hub, host, clients } = setupRoom();
    const session = host.start('normal', 77);
    hub.pump();
    const a = clients[0]!.rec.session!;
    const dt = 1 / 60;
    let sat = false;
    for (let tick = 0; tick < 60 * 30 && !sat; tick++) {
      // Steer A toward the first free seat once the doors open.
      const s = session.state;
      const me = s.players.find((p) => p.id === 'A')!;
      let input = NO_INPUT;
      if (s.phase === 'scramble' && s.freeSeatIds.length) {
        const seat = s.seats[s.freeSeatIds[0]!]!;
        const gx = seat.x - me.pos.x;
        const gz = seat.side * 1.25 - me.pos.z;
        const d = Math.hypot(gx, gz);
        input = { moveX: gx / Math.max(d, 0.3), moveZ: gz / Math.max(d, 0.3), action: d < 0.5 && tick % 10 === 0 };
      }
      a.update(dt, input);
      session.update(dt, NO_INPUT);
      clients[1]!.rec.session!.update(dt, NO_INPUT);
      hub.pump();
      sat = me.seatId !== null;
    }
    expect(sat).toBe(true);
  });

  it('keeps a remote player responsive under 100 ms latency (no rubber-banding)', () => {
    const { hub, host, clients } = setupRoom();
    hub.latency = 6; // ≈100 ms each way at 60 fps
    const session = host.start('normal', 5);
    for (let i = 0; i < 20; i++) hub.pump();
    const a = clients[0]!.rec.session!;
    const dt = 1 / 60;
    const shown = () => ({ ...a.view().players.find((p) => p.id === 'A')!.pos });
    let backwards = 0;
    let moved = 0;
    let speed = 0;
    for (let tick = 0; tick < 60 * 8; tick++) {
      const phase = session.state.phase;
      const active = phase === 'riding' || phase === 'scramble';
      // Walk left and right in 1-second strokes.
      const dir = Math.floor(tick / 60) % 2 === 0 ? 1 : -1;
      const before = shown();
      a.update(dt, active ? { moveX: dir, moveZ: 0, action: false } : NO_INPUT);
      session.update(dt, NO_INPUT);
      clients[1]!.rec.session!.update(dt, NO_INPUT);
      hub.pump();
      const after = shown();
      const me = session.state.players.find((p) => p.id === 'A')!;
      // Ignore frames at the ends of the car and on direction changes.
      if (active && me.seatId === null && tick % 60 > 15 && Math.abs(after.x) < 5) {
        moved++;
        if ((after.x - before.x) * dir < -0.002) backwards++;
        speed += ((after.x - before.x) * dir) / dt;
      }
    }
    expect(moved).toBeGreaterThan(60);
    // Before input acknowledgements the shown speed dropped to ~2.4 m/s (stiff controls).
    expect(speed / moved).toBeGreaterThan(CONFIG.player.speed * 0.85);
    expect(backwards).toBeLessThanOrEqual(3);
  });

  it('starts the next game with everyone\'s points carried over', () => {
    const { hub, host, clients } = setupRoom();
    host.start('normal', 3);
    hub.pump();
    const scores = new Map([['H', 70], ['A', 20], ['bot1', 5]]);
    const next = host.start('normal', 4, scores);
    for (let i = 0; i < 3; i++) hub.pump();
    const a = clients[0]!.rec.session!;
    expect(next.state.players.find((p) => p.id === 'A')!.score).toBe(20);
    expect(a.view().players.find((p) => p.id === 'H')!.score).toBe(70);
    expect(a.view().players.find((p) => p.id === 'B')!.score).toBe(0);
    // Snapshots keep clients in step as points change.
    next.state.players.find((p) => p.id === 'B')!.score = 15;
    for (let i = 0; i < 6; i++) {
      next.update(1 / 60, NO_INPUT);
      hub.pump();
    }
    expect(a.view().players.find((p) => p.id === 'B')!.score).toBe(15);
  });

  it('names bots bot_user_1, bot_user_2, …', () => {
    const { hub, host } = setupRoom();
    const session = host.start('normal', 5);
    hub.pump();
    expect(session.state.players.map((p) => p.name)).toEqual(['Host', 'Player A', 'Player B', 'bot_user_1']);
  });

  it('keeps a disconnected player in the game (no bot), standing still and shown offline', () => {
    const { hub, host, clients } = setupRoom();
    const session = host.start('normal', 5);
    hub.pump();
    clients[0]!.t.close();
    hub.pump();
    const a = session.state.players.find((p) => p.id === 'A')!;
    expect(a.isBot).toBe(false);
    expect(host.players.map((p) => p.id)).toContain('A');
    expect([...session.offline()]).toEqual(['A']);
    // Run into the riding phase: nobody moves A.
    for (let i = 0; i < 60 * 3; i++) session.update(1 / 60, NO_INPUT);
    const x = a.pos.x;
    for (let i = 0; i < 30; i++) session.update(1 / 60, NO_INPUT);
    expect(Math.abs(a.vel.x) + Math.abs(a.vel.z)).toBeLessThan(3); // only sway, no steering
    expect(a.pos.x).not.toBeNaN();
    hub.pump();
    // The other client sees A as offline.
    expect([...clients[1]!.rec.session!.offline()]).toEqual(['A']);
    void x;
  });

  it('lets a player who left rejoin the game in progress with the same character', () => {
    const { hub, host, hostT, clients } = setupRoom();
    const session = host.start('normal', 77);
    hub.pump();
    for (let i = 0; i < 60 * 4; i++) session.update(1 / 60, NO_INPUT);
    clients[0]!.net.leave(); // quits to the main menu
    hub.pump();
    hub.pump();
    expect([...session.offline()]).toEqual(['A']);

    // Comes back on a brand-new connection with the same device key.
    const t2 = new FakeTransport('A2', hub);
    FakeTransport.connect(hostT, t2);
    let back: ClientSession | null = null;
    const net2 = new ClientNet(t2, 'H', 'Player A', 'key-of-A', { lobby: () => {}, start: (s) => (back = s), closed: () => {} });
    for (let i = 0; i < 4; i++) hub.pump();
    expect(net2.id).toBe('A');
    expect(back).not.toBeNull();
    expect(back!.humanId).toBe('A');
    expect([...session.offline()]).toEqual([]);
    expect(host.players).toHaveLength(3);
    // Their input moves the original character again.
    for (let i = 0; i < 30; i++) {
      back!.update(1 / 60, { moveX: 1, moveZ: 0, action: false });
      session.update(1 / 60, NO_INPUT);
      hub.pump();
    }
    const a = session.state.players.find((p) => p.id === 'A')!;
    expect(a.vel.x).toBeGreaterThan(1);
    // And they receive the live game state.
    expect(back!.view().round).toBe(session.state.round);
  });

  it('refuses strangers once the game has started, and frees places for the next game', () => {
    const { hub, host, hostT, clients } = setupRoom();
    host.start('normal', 5);
    hub.pump();
    const s = new FakeTransport('S', hub);
    FakeTransport.connect(hostT, s);
    let reason: CloseReason | null = null;
    new ClientNet(s, 'H', 'Stranger', 'key-of-S', { lobby: () => {}, start: () => {}, closed: (r) => (reason = r) });
    for (let i = 0; i < 4; i++) hub.pump();
    expect(reason).toBe('started');
    // B leaves for good; the next game starts without them.
    clients[1]!.net.leave();
    hub.pump();
    hub.pump();
    const next = host.start('normal', 6);
    expect(next.state.players.map((p) => p.name)).toEqual(['Host', 'Player A', 'bot_user_1', 'bot_user_2']);
  });

  it('tells clients when the host leaves', () => {
    const { hub, host, clients } = setupRoom();
    host.start('normal', 5);
    hub.pump();
    host.close();
    hub.pump();
    hub.pump();
    expect(clients[1]!.rec.closed).toBe('hostLeft');
  });

  it('reports a dropped link as "lost" (not the host leaving), and silence during a game too', () => {
    vi.useFakeTimers();
    try {
      const { hub, host, hostT, clients } = setupRoom();
      host.start('normal', 5);
      hub.pump();
      // A: the connection itself drops, without a goodbye from the host.
      hostT.links.delete('A');
      clients[0]!.t.links.delete('H');
      clients[0]!.t.slot.peerClose('H');
      expect(clients[0]!.rec.closed).toBe('lost');
      // B: the link stays "open" but nothing arrives any more (weak signal).
      hostT.links.delete('B');
      vi.advanceTimersByTime(5000);
      expect(clients[1]!.rec.closed).toBe('lost');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a player whose signal dropped comes back to the same character at its current position', () => {
    const { hub, host, hostT, clients } = setupRoom();
    const session = host.start('normal', 8);
    for (let i = 0; i < 60 * 4; i++) {
      session.update(1 / 60, NO_INPUT);
      hub.pump();
    }
    const where = { ...session.state.players.find((p) => p.id === 'A')!.pos };
    clients[0]!.t.close();
    hub.pump();
    // Same device key, new connection.
    const t2 = new FakeTransport('A2', hub);
    FakeTransport.connect(hostT, t2);
    let back: ClientSession | null = null;
    new ClientNet(t2, 'H', 'Player A', 'key-of-A', { lobby: () => {}, start: (s) => (back = s), closed: () => {} });
    for (let i = 0; i < 5; i++) {
      session.update(1 / 60, NO_INPUT);
      hub.pump();
    }
    expect(back).not.toBeNull();
    const me = back!.view().players.find((p) => p.id === back!.humanId)!;
    expect(back!.humanId).toBe('A');
    expect(Math.hypot(me.pos.x - where.x, me.pos.z - where.z)).toBeLessThan(0.3);
    expect(session.state.players.filter((p) => p.isBot).length).toBe(1); // no bot took over
  });
});

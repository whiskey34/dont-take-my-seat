import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/core/config';
import { createGame, step } from '../src/core/game';
import { ClientNet, type ClientSession, type CloseReason } from '../src/net/client';
import { HostNet } from '../src/net/host';
import { applySnapshot, packSnapshot, parseClientMsg, parseHostMsg } from '../src/net/protocol';
import { HandlerSlot, type Channel, type Transport, type TransportHandlers } from '../src/net/transport';
import { NO_INPUT } from '../src/core/types';

/** In-memory network: a hub that delivers messages on the next pump. */
class Hub {
  queue: Array<() => void> = [];
  dropFast = 0;
  rng = 1;
  pump(): void {
    const q = this.queue;
    this.queue = [];
    q.forEach((fn) => fn());
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
    const net = new ClientNet(t, 'H', `Player ${id}`, {
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

  it('rejects malformed and hostile messages', () => {
    expect(parseClientMsg('not json')).toBeNull();
    expect(parseClientMsg('{"t":"in","s":1,"x":"1","z":0}')).toBeNull();
    expect(parseClientMsg('{"t":"nope"}')).toBeNull();
    expect(parseClientMsg('x'.repeat(70_000))).toBeNull();
    expect(parseClientMsg('{"t":"in","s":1,"x":50,"z":-50}')).toEqual({ t: 'in', s: 1, x: 1, z: -1 });
    expect(parseClientMsg('{"t":"hello","v":1,"name":"  \\u0000Budi\\u0007 the longest name ever "}')).toEqual({ t: 'hello', v: 1, name: 'Budi the longe' });
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
    new ClientNet(c, 'H', 'C', { lobby: () => {}, start: () => {}, closed: () => {} });
    const d = new FakeTransport('D', hub);
    FakeTransport.connect(hostT, d);
    let reason: CloseReason | null = null;
    new ClientNet(d, 'H', 'D', { lobby: () => {}, start: () => {}, closed: (r) => (reason = r) });
    for (let i = 0; i < 5; i++) hub.pump();
    expect(host.players).toHaveLength(CONFIG.maxPlayers);
    expect(reason).toBe('full');
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

  it('turns a player who disconnects into a bot, and tells clients when the host leaves', () => {
    const { hub, host, clients } = setupRoom();
    const session = host.start('normal', 5);
    hub.pump();
    clients[0]!.t.close();
    hub.pump();
    expect(session.state.players.find((p) => p.id === 'A')!.isBot).toBe(true);
    host.close();
    hub.pump();
    hub.pump();
    expect(clients[1]!.rec.closed).toBe('hostLeft');
  });
});

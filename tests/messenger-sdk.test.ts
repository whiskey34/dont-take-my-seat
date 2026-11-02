import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInvite, parseInvite } from '../messenger-sdk/src/invite';
import { MiniGameSession, parseEnvelope, type Channel, type PeerLink } from '../messenger-sdk/src/session';

type Sent = { from: string; to: string; channel: Channel; data: string };

/** Connects several sessions as if through the chat's P2P links. */
function network() {
  const queue: Sent[] = [];
  const sessions = new Map<string, MiniGameSession>();
  const games = new Map<string, Array<Record<string, unknown>>>();
  const linkFor = (from: string): PeerLink => ({ send: (to, channel, data) => queue.push({ from, to, channel, data }) });
  const add = (id: string, hostId: string, sessionId = 'S1', maxPlayers = 4) => {
    const got: Array<Record<string, unknown>> = [];
    games.set(id, got);
    const s = new MiniGameSession({
      sessionId,
      hostId,
      self: { id, name: id.toUpperCase() },
      link: linkFor(id),
      toGame: (json) => got.push(JSON.parse(json)),
      maxPlayers,
    });
    sessions.set(id, s);
    return s;
  };
  const pump = () => {
    while (queue.length) {
      const m = queue.shift()!;
      const env = parseEnvelope(m.data);
      if (env) sessions.get(m.to)?.fromPeer(m.from, m.channel, env);
    }
  };
  return { add, pump, games, sessions };
}

describe('messenger SDK session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects players to the host and forwards game data both ways', () => {
    const net = network();
    const host = net.add('a', 'a');
    const b = net.add('b', 'a');
    host.fromGame(JSON.stringify({ type: 'ready' }));
    b.fromGame(JSON.stringify({ type: 'ready' }));
    net.pump();

    expect(net.games.get('a')![0]).toMatchObject({ type: 'init', self: { id: 'a' }, session: { id: 'S1', hostId: 'a' } });
    expect(net.games.get('a')).toContainEqual({ type: 'peer', event: 'join', user: { id: 'b', name: 'B' } });
    expect(net.games.get('b')).toContainEqual({ type: 'peer', event: 'join', user: { id: 'a', name: 'A' } });

    b.fromGame(JSON.stringify({ type: 'send', to: 'a', channel: 'fast', data: '{"t":"in"}' }));
    host.fromGame(JSON.stringify({ type: 'send', to: 'b', channel: 'reliable', data: '{"t":"lobby"}' }));
    net.pump();
    expect(net.games.get('a')).toContainEqual({ type: 'message', from: 'b', channel: 'fast', data: '{"t":"in"}' });
    expect(net.games.get('b')).toContainEqual({ type: 'message', from: 'a', channel: 'reliable', data: '{"t":"lobby"}' });
  });

  it('lists players who joined before the host game loaded in init', () => {
    const net = network();
    const host = net.add('a', 'a');
    const b = net.add('b', 'a');
    b.fromGame(JSON.stringify({ type: 'ready' }));
    net.pump();
    host.fromGame(JSON.stringify({ type: 'ready' }));
    expect(net.games.get('a')![0]).toMatchObject({ type: 'init', session: { participants: [{ id: 'b', name: 'B' }] } });
  });

  it('keeps asking the host until it answers (host opens the game later)', () => {
    const net = network();
    const b = net.add('b', 'a');
    b.fromGame(JSON.stringify({ type: 'ready' }));
    net.pump(); // nobody home yet
    const host = net.add('a', 'a');
    host.fromGame(JSON.stringify({ type: 'ready' }));
    vi.advanceTimersByTime(1600);
    net.pump();
    expect(net.games.get('b')).toContainEqual({ type: 'peer', event: 'join', user: { id: 'a', name: 'A' } });
  });

  it('ignores other sessions, strangers, impostors and junk', () => {
    const net = network();
    const host = net.add('a', 'a');
    host.fromGame(JSON.stringify({ type: 'ready' }));
    expect(host.fromPeer('x', 'reliable', { g: 1, s: 'OTHER', k: 'join', u: { id: 'x', name: 'X' } })).toBe(false);
    host.fromPeer('x', 'reliable', { g: 1, s: 'S1', k: 'join', u: { id: 'someone-else', name: 'Y' } });
    host.fromPeer('x', 'reliable', { g: 1, s: 'S1', k: 'd', d: 'hi' });
    host.fromGame(JSON.stringify({ type: 'send', to: 'x', channel: 'reliable', data: 'leak' }));
    host.fromGame('not json');
    expect(net.games.get('a')!.filter((m) => m.type !== 'init')).toEqual([]);
    expect(parseEnvelope('{"g":2,"s":"S1","k":"d","d":"x"}')).toBeNull();
    expect(parseEnvelope('{"g":1,"s":"S1","k":"join"}')).toBeNull();
  });

  it('stops admitting at the player limit', () => {
    const net = network();
    const host = net.add('a', 'a', 'S1', 2);
    host.fromGame(JSON.stringify({ type: 'ready' }));
    for (const id of ['b', 'c']) {
      net.add(id, 'a', 'S1', 2).fromGame(JSON.stringify({ type: 'ready' }));
      net.pump();
    }
    const joins = net.games.get('a')!.filter((m) => m.type === 'peer');
    expect(joins).toHaveLength(1);
  });

  it('reports leaving players and dropped links to the game', () => {
    const net = network();
    const host = net.add('a', 'a');
    const b = net.add('b', 'a');
    const c = net.add('c', 'a');
    for (const s of [host, b, c]) s.fromGame(JSON.stringify({ type: 'ready' }));
    net.pump();
    b.close();
    net.pump();
    expect(net.games.get('a')).toContainEqual({ type: 'peer', event: 'leave', user: { id: 'b', name: 'B' } });
    host.peerConnection('c', false);
    expect(net.games.get('a')).toContainEqual({ type: 'peer', event: 'leave', user: { id: 'c', name: 'C' } });
  });

  it('passes results to the chat and closes on request', () => {
    const results: unknown[] = [];
    let closed = false;
    const s = new MiniGameSession({
      sessionId: 'S',
      hostId: 'a',
      self: { id: 'a', name: 'A' },
      link: { send: () => {} },
      toGame: () => {},
      onResult: (r) => results.push(r),
      onClose: () => (closed = true),
    });
    s.fromGame(JSON.stringify({ type: 'result', text: 'A wins', winner: 'A', ranking: ['A', 'B', 3] }));
    s.fromGame(JSON.stringify({ type: 'close' }));
    expect(results).toEqual([{ text: 'A wins', winner: 'A', ranking: ['A', 'B'] }]);
    expect(closed).toBe(true);
  });
});

describe('invites', () => {
  it('round-trips through a chat message and rejects junk', () => {
    const inv = createInvite({ id: 'u1', name: 'Andi' });
    expect(inv.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(parseInvite(JSON.parse(JSON.stringify(inv)))).toEqual(inv);
    expect(parseInvite({ ...inv, type: 'text' })).toBeNull();
    expect(parseInvite({ ...inv, hostId: '' })).toBeNull();
  });
});

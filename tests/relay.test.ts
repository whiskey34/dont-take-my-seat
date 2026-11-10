import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomSignaling } from '../src/net/signal/roomSignaling';
import type { SignalMsg } from '../src/net/signal/signal';

/**
 * A fake Nostr relay network: every FakeSocket is a client connection.
 * Events are delivered to subscriptions whose '#t' filter matches.
 */
class Hub {
  sockets: FakeSocket[] = [];
  reachable = true;
  route(from: FakeSocket, ev: { tags: string[][] }): void {
    for (const s of this.sockets) {
      if (s.readyState !== FakeSocket.OPEN) continue;
      for (const [subId, topic] of s.subs) {
        if (ev.tags.some((t) => t[0] === 't' && t[1] === topic)) s.deliver(JSON.stringify(['EVENT', subId, ev]));
      }
    }
    void from;
  }
}

let hub: Hub;

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = 'blob';
  subs = new Map<string, string>();
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    hub.sockets.push(this);
    setTimeout(() => {
      if (!hub.reachable) return this.drop();
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }, 10);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as unknown[];
    if (msg[0] === 'REQ') this.subs.set(msg[1] as string, (msg[2] as { '#t': string[] })['#t'][0]!);
    if (msg[0] === 'EVENT') hub.route(this, msg[1] as { tags: string[][] });
  }
  deliver(data: string): void {
    setTimeout(() => this.onmessage?.({ data }), 1);
  }
  /** The network (or a sleeping phone) kills the connection. */
  drop(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  close(): void {
    this.drop();
  }
}

const relays = { mqtt: [], nostr: ['wss://fake.relay'] };

/** Moves fake time forward while letting real async work (WebCrypto) finish. */
async function settle(ms = 50): Promise<void> {
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    await new Promise((r) => setImmediate(r)); // a real event-loop turn (setImmediate is not faked)
    await vi.advanceTimersByTimeAsync(ms / steps);
  }
}

/** Real time, for WebCrypto (not driven by fake timers), which can be slow on CI. */
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

/** Waits (real turns + small fake steps) until a condition holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
    if (i % 25 === 24) await realWait(2);
    await vi.advanceTimersByTimeAsync(2);
  }
  throw new Error('condition not met');
}

/** The live socket behind a RoomSignaling's (single) relay link. */
const socketOf = (s: RoomSignaling) => (s as unknown as { links: Array<{ ws: FakeSocket }> }).links[0]!.ws;

const openSockets = () => hub.sockets.filter((x) => x.readyState === FakeSocket.OPEN).length;

const hello = (from: string): SignalMsg => ({ type: 'hello', from });

describe('room signaling over relays', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    hub = new Hub();
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('delivers encrypted messages between two devices with the same code', async () => {
    const host = new RoomSignaling('ABCDE', relays);
    const guest = new RoomSignaling('ABCDE', relays);
    const stranger = new RoomSignaling('ZZZZZ', relays);
    await until(() => openSockets() === 3);
    await Promise.all([host.ready, guest.ready]);
    const got: SignalMsg[] = [];
    const strangerGot: SignalMsg[] = [];
    host.onMessage((m) => got.push(m));
    stranger.onMessage((m) => strangerGot.push(m));
    guest.publish(hello('p1'));
    await until(() => got.length === 1);
    await settle();
    expect(got).toEqual([hello('p1')]);
    expect(strangerGot).toEqual([]);
  });

  it('reconnects after the host phone drops the socket (e.g. switching to WhatsApp)', async () => {
    const host = new RoomSignaling('ABCDE', relays);
    const guest = new RoomSignaling('ABCDE', relays);
    await until(() => openSockets() === 2 && host.isUp && guest.isUp);
    const got: SignalMsg[] = [];
    const status: boolean[] = [];
    host.onMessage((m) => got.push(m));
    host.onStatus((up) => status.push(up));

    // Kill the host's connection.
    socketOf(host).drop();
    expect(host.isUp).toBe(false);
    guest.publish(hello('lost'));
    await settle(20);
    expect(got).toEqual([]);

    // It comes back by itself after a short backoff.
    await settle(1200);
    expect(host.isUp).toBe(true);
    await until(() => guest.isUp);
    guest.publish(hello('p1'));
    await until(() => got.length === 1);
    expect(got).toEqual([hello('p1')]);
    expect(status).toEqual([false, true]);
  });

  it('keeps retrying while the network is down, and reconnects at once when the page is visible again', async () => {
    const host = new RoomSignaling('ABCDE', relays);
    await until(() => host.isUp);
    hub.reachable = false;
    socketOf(host).drop();
    await settle(20_000); // several failed retries, backoff grows
    expect(host.isUp).toBe(false);
    hub.reachable = true;
    // Simulate the page coming back to the foreground.
    (host as unknown as { wakeAll: () => void }).wakeAll();
    await settle(30);
    expect(host.isUp).toBe(true);
  });

  it('reports unreachable when no relay answers at first', async () => {
    hub.reachable = false;
    const s = new RoomSignaling('ABCDE', relays);
    const result = s.ready.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    let done = '';
    void result.then((r) => (done = r));
    await until(() => done !== '');
    expect(done).toBe('signaling-unreachable');
    s.close();
  });
});

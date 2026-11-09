import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignalMsg, Signaling } from '../src/net/signal/signal';

/** Fake WebRTC peer: the test decides whether it opens or fails. */
const peers: FakePeer[] = [];
class FakePeer {
  onOpen = () => {};
  onClose = () => {};
  onMessage = () => {};
  isOpen = false;
  closed = false;
  constructor() {
    peers.push(this);
  }
  async acceptOffer(): Promise<string> {
    return 'answer-sdp';
  }
  open(): void {
    this.isOpen = true;
    this.onOpen();
  }
  fail(): void {
    this.closed = true;
    this.onClose();
  }
  close(): void {
    this.closed = true;
  }
  send(): void {}
}
vi.mock('../src/net/rtc/peer', () => ({ Peer: FakePeer }));

const { RtcJoinTransport } = await import('../src/net/rtc/room');

class FakeSignaling implements Signaling {
  ready = Promise.resolve();
  sent: SignalMsg[] = [];
  private cb: (m: SignalMsg) => void = () => {};
  publish(m: SignalMsg): void {
    this.sent.push(m);
  }
  onMessage(cb: (m: SignalMsg) => void): void {
    this.cb = cb;
  }
  deliver(m: SignalMsg): void {
    this.cb(m);
  }
  close(): void {}
}

describe('joining a room', () => {
  let n = 0;
  const newId = () => `p${++n}`;
  beforeEach(() => {
    vi.useFakeTimers();
    peers.length = 0;
    n = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('keeps saying hello until the host offers, then answers', async () => {
    const sig = new FakeSignaling();
    const stages: string[] = [];
    new RtcJoinTransport(sig, newId, () => {}, (s) => stages.push(s));
    vi.advanceTimersByTime(3100);
    expect(sig.sent.filter((m) => m.type === 'hello').length).toBe(3);
    sig.deliver({ type: 'offer', from: 'h1', to: 'p1', sdp: 'x' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sig.sent.at(-1)).toEqual({ type: 'answer', from: 'p1', to: 'h1', sdp: 'answer-sdp' });
    expect(stages).toEqual(['searching', 'connecting']);
    // No more hellos once an offer is being answered.
    const hellos = sig.sent.filter((m) => m.type === 'hello').length;
    vi.advanceTimersByTime(5000);
    expect(sig.sent.filter((m) => m.type === 'hello').length).toBe(hellos);
  });

  it('starts over with a fresh id when the direct connection fails', async () => {
    const sig = new FakeSignaling();
    const stages: string[] = [];
    const t = new RtcJoinTransport(sig, newId, () => {}, (s) => stages.push(s));
    sig.deliver({ type: 'offer', from: 'h1', to: 'p1', sdp: 'x' });
    await vi.advanceTimersByTimeAsync(10);
    peers[0]!.fail(); // ICE failed
    expect(stages.at(-1)).toBe('retrying');
    expect(t.selfId).toBe('p2');
    expect(sig.sent.at(-1)).toEqual({ type: 'hello', from: 'p2' });
    // An offer for the old id is ignored; the new one works.
    sig.deliver({ type: 'offer', from: 'h1', to: 'p1', sdp: 'x' });
    sig.deliver({ type: 'offer', from: 'h1', to: 'p2', sdp: 'x' });
    await vi.advanceTimersByTimeAsync(10);
    expect(peers).toHaveLength(2);
    peers[1]!.open();
    expect(t.peers()).toEqual(['h1']);
  });

  it('retries when a connection attempt hangs', async () => {
    const sig = new FakeSignaling();
    const t = new RtcJoinTransport(sig, newId, () => {});
    sig.deliver({ type: 'offer', from: 'h1', to: 'p1', sdp: 'x' });
    await vi.advanceTimersByTimeAsync(15_100);
    expect(peers[0]!.closed).toBe(true);
    expect(t.selfId).toBe('p2');
  });

  it('reports "room not found" when no host ever answers', () => {
    const sig = new FakeSignaling();
    const fail = vi.fn();
    new RtcJoinTransport(sig, newId, fail);
    vi.advanceTimersByTime(60_100);
    expect(fail).toHaveBeenCalledWith('timeout');
  });

  it('reports "found but cannot connect" when the host answers but links keep failing', async () => {
    const sig = new FakeSignaling();
    const fail = vi.fn();
    new RtcJoinTransport(sig, newId, fail);
    for (let i = 1; i <= 3; i++) {
      sig.deliver({ type: 'offer', from: 'h1', to: `p${i}`, sdp: 'x' });
      await vi.advanceTimersByTimeAsync(10);
      peers.at(-1)!.fail();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fail).toHaveBeenCalledWith('unreachable');
  });

  it('a host leaving after connecting is reported as such, not retried', async () => {
    const sig = new FakeSignaling();
    const t = new RtcJoinTransport(sig, newId, () => {});
    const closed = vi.fn();
    t.setHandlers({ message: () => {}, peerOpen: () => {}, peerClose: closed });
    sig.deliver({ type: 'offer', from: 'h1', to: 'p1', sdp: 'x' });
    await vi.advanceTimersByTimeAsync(10);
    peers[0]!.open();
    peers[0]!.fail();
    expect(closed).toHaveBeenCalledWith('h1');
    expect(t.selfId).toBe('p1');
  });
});

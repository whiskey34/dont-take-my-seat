import { HandlerSlot, type Channel, type Transport, type TransportHandlers } from '../transport';
import type { Signaling, SignalMsg } from '../signal/signal';
import { Peer } from './peer';

const PENDING_TIMEOUT_MS = 16_000;
const HELLO_INTERVAL_MS = 1500;
const JOIN_TIMEOUT_MS = 60_000;

/** Host side: answers every "hello" in the room with an offer (star topology). */
export class RtcHostTransport implements Transport {
  private readonly slot = new HandlerSlot();
  private readonly links = new Map<string, Peer>();
  private closed = false;

  constructor(
    private readonly signaling: Signaling,
    readonly selfId: string,
    private readonly accepting: () => boolean,
  ) {
    signaling.onMessage((m) => void this.onSignal(m));
  }

  peers(): string[] {
    return [...this.links].filter(([, p]) => p.isOpen).map(([id]) => id);
  }

  send(to: string, channel: Channel, data: string): void {
    this.links.get(to)?.send(channel, data);
  }

  setHandlers(h: TransportHandlers): void {
    this.slot.set(h);
  }

  close(): void {
    this.closed = true;
    this.signaling.close();
    for (const p of this.links.values()) p.close();
    this.links.clear();
  }

  private async onSignal(m: SignalMsg): Promise<void> {
    if (this.closed || m.from === this.selfId) return;
    if (m.type === 'hello') {
      if (this.links.has(m.from) || !this.accepting()) return;
      const peer = new Peer();
      this.links.set(m.from, peer);
      peer.onOpen = () => this.slot.peerOpen(m.from);
      peer.onMessage = (ch, data) => this.slot.message(m.from, ch, data);
      peer.onClose = () => {
        const wasOpen = this.links.get(m.from) === peer;
        if (wasOpen) this.links.delete(m.from);
        if (wasOpen) this.slot.peerClose(m.from);
      };
      setTimeout(() => {
        if (!peer.isOpen && this.links.get(m.from) === peer) {
          this.links.delete(m.from);
          peer.close();
        }
      }, PENDING_TIMEOUT_MS);
      try {
        const sdp = await peer.createOffer();
        if (!this.closed) this.signaling.publish({ type: 'offer', from: this.selfId, to: m.from, sdp });
      } catch {
        this.links.delete(m.from);
        peer.close();
      }
    } else if (m.type === 'answer' && m.to === this.selfId) {
      await this.links
        .get(m.from)
        ?.acceptAnswer(m.sdp)
        .catch(() => {});
    }
  }
}

export type JoinStage = 'searching' | 'connecting' | 'retrying';
export type JoinFailure = 'timeout' | 'unreachable';

const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Joiner side: says hello until a host offers, then answers.
 * If the direct connection does not come up, it starts over with a fresh id
 * (so the host makes a fresh offer) until the overall timeout.
 */
export class RtcJoinTransport implements Transport {
  private readonly slot = new HandlerSlot();
  private peer: Peer | null = null;
  private hostId: string | null = null;
  private id: string;
  private hello: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private foundHost = false;
  private connected = false;
  private closed = false;

  constructor(
    private readonly signaling: Signaling,
    private readonly newId: () => string,
    private readonly onFail: (reason: JoinFailure) => void,
    private readonly onStage: (stage: JoinStage) => void = () => {},
    joinTimeoutMs = JOIN_TIMEOUT_MS,
  ) {
    this.id = newId();
    signaling.onMessage((m) => void this.onSignal(m));
    this.startHello();
    this.onStage('searching');
    this.timeout = setTimeout(() => {
      if (this.connected) return;
      this.close();
      this.onFail(this.foundHost ? 'unreachable' : 'timeout');
    }, joinTimeoutMs);
  }

  get selfId(): string {
    return this.id;
  }

  peers(): string[] {
    return this.connected && this.hostId ? [this.hostId] : [];
  }

  send(to: string, channel: Channel, data: string): void {
    if (to === this.hostId) this.peer?.send(channel, data);
  }

  setHandlers(h: TransportHandlers): void {
    this.slot.set(h);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopSignaling();
    this.peer?.close();
  }

  private startHello(): void {
    if (this.hello) clearInterval(this.hello);
    const sayHello = () => this.signaling.publish({ type: 'hello', from: this.id });
    sayHello();
    this.hello = setInterval(sayHello, HELLO_INTERVAL_MS);
  }

  private stopSignaling(): void {
    if (this.hello) clearInterval(this.hello);
    if (this.timeout) clearTimeout(this.timeout);
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    this.hello = null;
    this.timeout = null;
    this.attemptTimer = null;
    this.signaling.close();
  }

  /** The direct connection did not come up: forget this attempt and ask again. */
  private retry(peer: Peer): void {
    if (this.closed || this.connected || this.peer !== peer) return;
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
    this.peer = null;
    this.hostId = null;
    peer.onClose = () => {};
    peer.close();
    this.id = this.newId();
    this.onStage('retrying');
    this.startHello();
  }

  private async onSignal(m: SignalMsg): Promise<void> {
    if (this.closed || m.type !== 'offer' || m.to !== this.id || this.peer) return;
    const host = m.from;
    const peer = new Peer();
    this.peer = peer;
    this.hostId = host;
    this.foundHost = true;
    this.onStage('connecting');
    if (this.hello) clearInterval(this.hello);
    this.hello = null;
    peer.onOpen = () => {
      this.connected = true;
      // Connected directly; the public relays are no longer needed.
      this.stopSignaling();
      this.slot.peerOpen(host);
    };
    peer.onMessage = (ch, data) => this.slot.message(host, ch, data);
    peer.onClose = () => {
      if (this.connected) this.slot.peerClose(host);
      else this.retry(peer);
    };
    this.attemptTimer = setTimeout(() => this.retry(peer), ATTEMPT_TIMEOUT_MS);
    try {
      const sdp = await peer.acceptOffer(m.sdp);
      if (this.peer === peer) this.signaling.publish({ type: 'answer', from: this.id, to: host, sdp });
    } catch {
      this.retry(peer);
    }
  }
}

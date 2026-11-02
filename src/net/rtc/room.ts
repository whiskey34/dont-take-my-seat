import { HandlerSlot, type Channel, type Transport, type TransportHandlers } from '../transport';
import type { Signaling, SignalMsg } from '../signal/signal';
import { Peer } from './peer';

const PENDING_TIMEOUT_MS = 20_000;
const HELLO_INTERVAL_MS = 1500;
const JOIN_TIMEOUT_MS = 25_000;

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

/** Joiner side: says hello until a host offers, then answers. */
export class RtcJoinTransport implements Transport {
  private readonly slot = new HandlerSlot();
  private peer: Peer | null = null;
  private hostId: string | null = null;
  private hello: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly signaling: Signaling,
    readonly selfId: string,
    private readonly onFail: (reason: 'timeout') => void,
  ) {
    signaling.onMessage((m) => void this.onSignal(m));
    const sayHello = () => signaling.publish({ type: 'hello', from: selfId });
    sayHello();
    this.hello = setInterval(sayHello, HELLO_INTERVAL_MS);
    this.timeout = setTimeout(() => {
      if (!this.peer?.isOpen) {
        this.close();
        this.onFail('timeout');
      }
    }, JOIN_TIMEOUT_MS);
  }

  peers(): string[] {
    return this.peer?.isOpen && this.hostId ? [this.hostId] : [];
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

  private stopSignaling(): void {
    if (this.hello) clearInterval(this.hello);
    if (this.timeout) clearTimeout(this.timeout);
    this.hello = null;
    this.timeout = null;
    this.signaling.close();
  }

  private async onSignal(m: SignalMsg): Promise<void> {
    if (this.closed || m.type !== 'offer' || m.to !== this.selfId || this.peer) return;
    const host = m.from;
    const peer = new Peer();
    this.peer = peer;
    this.hostId = host;
    if (this.hello) clearInterval(this.hello);
    peer.onOpen = () => {
      // Connected directly; the public broker is no longer needed.
      this.stopSignaling();
      this.slot.peerOpen(host);
    };
    peer.onMessage = (ch, data) => this.slot.message(host, ch, data);
    peer.onClose = () => this.slot.peerClose(host);
    try {
      const sdp = await peer.acceptOffer(m.sdp);
      this.signaling.publish({ type: 'answer', from: this.selfId, to: host, sdp });
    } catch {
      this.peer = null;
      this.hostId = null;
      peer.close();
      this.hello = setInterval(() => this.signaling.publish({ type: 'hello', from: this.selfId }), HELLO_INTERVAL_MS);
    }
  }
}

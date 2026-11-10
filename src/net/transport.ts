/**
 * A transport connects this device to the other players. The game never
 * talks to WebRTC or the messenger directly; it only uses this interface.
 *
 * - 'reliable': ordered, never lost (events, actions, lobby).
 * - 'fast': may drop or reorder (movement input, snapshots).
 *   Transports without an unreliable channel may send it reliably.
 */
export type Channel = 'reliable' | 'fast';

export interface TransportHandlers {
  message(from: string, channel: Channel, data: string): void;
  peerOpen(peerId: string): void;
  peerClose(peerId: string): void;
}

export interface Transport {
  readonly selfId: string;
  /** Peers currently connected. A client is connected only to the host. */
  peers(): string[];
  send(to: string, channel: Channel, data: string): void;
  setHandlers(h: TransportHandlers): void;
  close(): void;
  /** How the connection to a peer travels (for the debug panel), if known. */
  route?(peer: string): Promise<string>;
  /** Round-trip time to a peer in ms, if this transport can measure it. */
  rtt?(peer: string): Promise<number | null>;
}

/** Holds handlers until the session attaches; buffers early events. */
export class HandlerSlot implements TransportHandlers {
  private h: TransportHandlers | null = null;
  private queue: Array<(h: TransportHandlers) => void> = [];

  set(h: TransportHandlers): void {
    this.h = h;
    const q = this.queue;
    this.queue = [];
    q.forEach((fn) => fn(h));
  }

  private call(fn: (h: TransportHandlers) => void): void {
    if (this.h) fn(this.h);
    else this.queue.push(fn);
  }

  message(from: string, channel: Channel, data: string): void {
    this.call((h) => h.message(from, channel, data));
  }
  peerOpen(peerId: string): void {
    this.call((h) => h.peerOpen(peerId));
  }
  peerClose(peerId: string): void {
    this.call((h) => h.peerClose(peerId));
  }
}

import { workerRoomUrl } from '../config';
import { fromBase64, toBase64 } from './crypto';
import { RelayLink } from './relayLink';

/**
 * Our own Cloudflare Worker: one WebSocket per room on port 443, the most
 * reliable path on mobile networks. The Worker only forwards the encrypted
 * text it receives to the other people in the same room.
 */
export class WorkerLink extends RelayLink {
  constructor(
    base: string,
    topic: string,
    private readonly onPayload: (p: Uint8Array<ArrayBuffer>) => void,
  ) {
    super(workerRoomUrl(base, topic));
  }

  publish(payload: Uint8Array): void {
    this.send(toBase64(payload));
  }

  protected onOpen(): void {
    this.markReady();
  }

  protected onData(data: unknown): void {
    if (typeof data !== 'string' || data.length > 16_000) return;
    const bytes = fromBase64(data);
    if (bytes) this.onPayload(bytes);
  }
}

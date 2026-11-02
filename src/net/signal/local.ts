import { parseSignal, type SignalMsg, type Signaling } from './signal';

/**
 * Signaling between tabs of the same browser (BroadcastChannel).
 * For development and automated tests: add `?signal=local` to the URL.
 */
export class LocalSignaling implements Signaling {
  readonly ready = Promise.resolve();
  private readonly ch: BroadcastChannel;
  private listeners: Array<(m: SignalMsg) => void> = [];

  constructor(code: string) {
    this.ch = new BroadcastChannel(`dtms-signal-${code}`);
    this.ch.onmessage = (e) => {
      const msg = parseSignal(e.data);
      if (msg) this.listeners.forEach((cb) => cb(msg));
    };
  }

  publish(msg: SignalMsg): void {
    this.ch.postMessage(msg);
  }

  onMessage(cb: (msg: SignalMsg) => void): void {
    this.listeners.push(cb);
  }

  close(): void {
    this.ch.close();
    this.listeners = [];
  }
}

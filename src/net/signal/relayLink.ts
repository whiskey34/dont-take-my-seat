/**
 * A WebSocket to one public relay that keeps itself alive.
 *
 * Phones suspend background tabs: when the host switches to WhatsApp to share
 * the room code, the socket is usually dropped. The link reconnects with
 * backoff, and right away when `wake()` is called (page visible again,
 * network back online), so the room is reachable again as soon as the host
 * returns.
 */
const CONNECT_TIMEOUT_MS = 7000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

export abstract class RelayLink {
  protected ws: WebSocket | null = null;
  private up = false;
  private closed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private settle!: { resolve: () => void; reject: (e: Error) => void };
  private settled = false;
  /** Resolves on the first successful connection; rejects if the first try fails (retries continue). */
  readonly ready: Promise<void>;
  /** Called whenever the link goes up or down. */
  onStatus: (up: boolean) => void = () => {};

  constructor(
    readonly url: string,
    private readonly protocol?: string,
  ) {
    this.ready = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    this.ready.catch(() => {});
    // Let subclasses finish their constructors before the first connect.
    queueMicrotask(() => this.connect());
  }

  get isUp(): boolean {
    return this.up;
  }

  /** Reconnect now if the link is down (no-op when healthy). */
  wake(): void {
    if (this.closed || this.up || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const ws = this.ws;
    this.ws = null;
    this.setUp(false);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  /** Sends if connected; messages while down are dropped (callers repeat what matters). */
  protected send(data: string | Uint8Array<ArrayBuffer>): void {
    if (this.up && this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  /** Subclasses call this once their handshake (CONNACK/SUBACK, REQ) is done. */
  protected markReady(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.attempt = 0;
    this.setUp(true);
    if (!this.settled) {
      this.settled = true;
      this.settle.resolve();
    }
  }

  protected abstract onOpen(): void;
  protected abstract onData(data: unknown): void;
  protected onDown(): void {}

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = this.protocol ? new WebSocket(this.url, this.protocol) : new WebSocket(this.url);
    } catch {
      this.failed();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && !this.up) ws.close();
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => this.ws === ws && this.onOpen();
    ws.onmessage = (e: MessageEvent) => this.ws === ws && this.onData(e.data);
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.setUp(false);
      this.onDown();
      this.failed();
    };
  }

  private failed(): void {
    if (!this.settled) {
      this.settled = true;
      this.settle.reject(new Error(`relay unreachable: ${this.url}`));
    }
    if (this.closed || this.retryTimer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    this.onStatus(up);
  }
}

import { HandlerSlot, type Channel, type Transport, type TransportHandlers } from './transport';

/**
 * Mini Game SDK, game side. The messenger app opens the game in a WebView
 * and passes JSON strings both ways. See docs/MESSENGER_SDK.md.
 *
 * Game -> messenger: one of the bridges below, called with a JSON string.
 * Messenger -> game:  window.miniGameReceive(jsonString)
 */
export const SDK_VERSION = 1;

export interface MessengerUser {
  id: string;
  name: string;
}

export interface MessengerInit {
  type: 'init';
  sdk: number;
  self: MessengerUser & { lang?: string };
  session: { id: string; hostId: string; participants: MessengerUser[] };
}

export type ToMessenger =
  | { type: 'ready'; sdk: number; game: string; version: string }
  | { type: 'send'; to: string; channel: Channel; data: string }
  | { type: 'result'; text: string; winner: string | null; ranking: string[] }
  | { type: 'close' };

type FromMessenger =
  | MessengerInit
  | { type: 'message'; from: string; channel: Channel; data: string }
  | { type: 'peer'; event: 'join' | 'leave'; user: MessengerUser }
  | { type: 'lifecycle'; state: 'background' | 'foreground' };

declare global {
  interface Window {
    miniGameReceive?: (json: string) => void;
    MiniGameBridge?: { postMessage(json: string): void };
    ReactNativeWebView?: { postMessage(json: string): void };
    webkit?: { messageHandlers?: { miniGame?: { postMessage(json: string): void } } };
    flutter_inappwebview?: { callHandler(name: string, ...args: unknown[]): unknown };
  }
}

let iframeBridge: ((json: string) => void) | null | undefined;

/**
 * Inside a web-based messenger (Ionic/Capacitor, PWA) the game runs in an
 * iframe opened with ?embed=messenger&origin=<messenger origin>. Messages go
 * through postMessage, and only the parent window at that origin is trusted.
 */
function setupIframeBridge(): ((json: string) => void) | null {
  if (iframeBridge !== undefined) return iframeBridge;
  iframeBridge = null;
  const params = new URLSearchParams(location.search);
  if (params.get('embed') !== 'messenger' || window.parent === window) return null;
  const origin = params.get('origin');
  if (!origin) return null;
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== origin || typeof e.data !== 'string') return;
    window.miniGameReceive?.(e.data);
  });
  iframeBridge = (json) => window.parent.postMessage(json, origin);
  return iframeBridge;
}

/** Finds whichever bridge the host app provides (iframe, Android, iOS, React Native, Flutter). */
export function findBridge(): ((json: string) => void) | null {
  const iframe = setupIframeBridge();
  if (iframe) return iframe;
  const w = window;
  if (w.MiniGameBridge?.postMessage) return (j) => w.MiniGameBridge!.postMessage(j);
  if (w.webkit?.messageHandlers?.miniGame) return (j) => w.webkit!.messageHandlers!.miniGame!.postMessage(j);
  if (w.ReactNativeWebView?.postMessage) return (j) => w.ReactNativeWebView!.postMessage(j);
  if (w.flutter_inappwebview?.callHandler) return (j) => void w.flutter_inappwebview!.callHandler('miniGame', j);
  return null;
}

function parseFromMessenger(json: string): FromMessenger | null {
  let m: unknown;
  try {
    m = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  const user = (u: unknown): u is MessengerUser =>
    typeof u === 'object' && u !== null && typeof (u as MessengerUser).id === 'string' && typeof (u as MessengerUser).name === 'string';
  switch (o.type) {
    case 'init': {
      const s = o.session as Record<string, unknown> | undefined;
      if (!user(o.self) || !s || typeof s.id !== 'string' || typeof s.hostId !== 'string' || !Array.isArray(s.participants)) return null;
      return { type: 'init', sdk: Number(o.sdk) || 0, self: o.self, session: { id: s.id, hostId: s.hostId, participants: s.participants.filter(user) } };
    }
    case 'message':
      if (typeof o.from !== 'string' || typeof o.data !== 'string') return null;
      return { type: 'message', from: o.from, channel: o.channel === 'fast' ? 'fast' : 'reliable', data: o.data };
    case 'peer':
      if (!user(o.user) || (o.event !== 'join' && o.event !== 'leave')) return null;
      return { type: 'peer', event: o.event, user: o.user };
    case 'lifecycle':
      return o.state === 'background' || o.state === 'foreground' ? { type: 'lifecycle', state: o.state } : null;
    default:
      return null;
  }
}

/** Transport that sends game data through the messenger's own P2P links. */
export class MessengerTransport implements Transport {
  private readonly slot = new HandlerSlot();
  private readonly connected = new Set<string>();
  onLifecycle: (state: 'background' | 'foreground') => void = () => {};

  private constructor(
    private readonly post: (msg: ToMessenger) => void,
    readonly init: MessengerInit,
  ) {}

  get selfId(): string {
    return this.init.self.id;
  }

  /** Says hello to the messenger and waits for the session details. */
  static connect(version: string, timeoutMs = 4000): Promise<MessengerTransport> {
    const bridge = findBridge();
    if (!bridge) return Promise.reject(new Error('no-bridge'));
    const post = (msg: ToMessenger) => bridge(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      let transport: MessengerTransport | null = null;
      const timer = setTimeout(() => reject(new Error('no-init')), timeoutMs);
      window.miniGameReceive = (json: string) => {
        const m = parseFromMessenger(json);
        if (!m) return;
        if (m.type === 'init' && !transport) {
          clearTimeout(timer);
          transport = new MessengerTransport(post, m);
          resolve(transport);
          // Everyone already in the session counts as reachable.
          for (const p of m.session.participants) transport.peerJoined(p.id);
          return;
        }
        transport?.handle(m);
      };
      post({ type: 'ready', sdk: SDK_VERSION, game: 'dont-take-my-seat', version });
    });
  }

  peers(): string[] {
    return [...this.connected];
  }

  send(to: string, channel: Channel, data: string): void {
    if (this.connected.has(to)) this.post({ type: 'send', to, channel, data });
  }

  setHandlers(h: TransportHandlers): void {
    this.slot.set(h);
  }

  /** Shows a result card in the chat. */
  postResult(text: string, winner: string | null, ranking: string[]): void {
    this.post({ type: 'result', text, winner, ranking });
  }

  close(): void {
    this.post({ type: 'close' });
    for (const id of this.connected) this.slot.peerClose(id);
    this.connected.clear();
  }

  private peerJoined(id: string): void {
    if (id === this.selfId || this.connected.has(id)) return;
    this.connected.add(id);
    this.slot.peerOpen(id);
  }

  private handle(m: FromMessenger): void {
    if (m.type === 'message' && this.connected.has(m.from)) this.slot.message(m.from, m.channel, m.data);
    else if (m.type === 'peer' && m.event === 'join') this.peerJoined(m.user.id);
    else if (m.type === 'peer' && m.event === 'leave' && this.connected.delete(m.user.id)) this.slot.peerClose(m.user.id);
    else if (m.type === 'lifecycle') this.onLifecycle(m.state);
  }
}

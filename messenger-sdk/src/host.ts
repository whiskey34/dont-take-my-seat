import { createResultCard, type GameInvite, type GameResultCard } from './invite';
import { MiniGameSession, parseEnvelope, type Channel, type ChatUser, type PeerLink } from './session';

export const DEFAULT_GAME_URL = 'https://whiskey34.github.io/dont-take-my-seat/';

export interface MiniGameHostOptions {
  /** The chat app's links to contacts (usually a `GameLinks`). */
  link: PeerLink;
  /** Where the game is served. Use a bundled copy for offline play. */
  gameUrl?: string;
  /** Element the full-screen game is placed in (default: document.body). */
  container?: HTMLElement;
  /** Called when a game is opened/closed, e.g. to lock landscape with @capacitor/screen-orientation. */
  onOpen?: () => void | Promise<void>;
  onClosed?: () => void | Promise<void>;
}

export interface OpenOptions {
  invite: GameInvite;
  self: ChatUser & { lang?: string };
  /** Post this card into the chat (only the host's device calls it). */
  onResult?: (card: GameResultCard) => void;
}

/**
 * Runs mini games inside the chat app: opens the game in a full-screen
 * iframe and connects it to the chat's P2P links.
 */
export class MiniGameHost {
  private session: MiniGameSession | null = null;
  private frame: HTMLIFrameElement | null = null;
  private wrapper: HTMLElement | null = null;
  private gameOrigin: string;
  private readonly gameUrl: string;

  constructor(private readonly o: MiniGameHostOptions) {
    this.gameUrl = o.gameUrl ?? DEFAULT_GAME_URL;
    this.gameOrigin = new URL(this.gameUrl, location.href).origin;
    window.addEventListener('message', this.onWindowMessage);
  }

  get isOpen(): boolean {
    return this.session !== null;
  }

  /** Pass every message from `GameLinks.setMessageHandler` here. */
  handlePeerMessage(from: string, channel: Channel, data: string): void {
    const env = parseEnvelope(data);
    if (env && this.session) this.session.fromPeer(from, channel, env);
  }

  /** Pass `GameLinks.setStateHandler` events here. */
  handlePeerState(userId: string, connected: boolean): void {
    this.session?.peerConnection(userId, connected);
  }

  /** Forward the app's pause/resume (e.g. Capacitor App 'appStateChange'). */
  handleLifecycle(active: boolean): void {
    this.session?.lifecycle(active ? 'foreground' : 'background');
  }

  open(opts: OpenOptions): void {
    this.close();
    const { invite } = opts;
    const url = new URL(this.gameUrl, location.href);
    url.searchParams.set('embed', 'messenger');
    url.searchParams.set('origin', location.origin);
    this.gameOrigin = url.origin;

    const wrapper = document.createElement('div');
    wrapper.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;background:#17232f');
    const frame = document.createElement('iframe');
    frame.setAttribute('allow', 'autoplay; fullscreen; screen-wake-lock');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('style', 'border:0;width:100%;height:100%;display:block');
    frame.title = invite.title;
    wrapper.append(frame);
    this.wrapper = wrapper;
    this.frame = frame;

    this.session = new MiniGameSession({
      sessionId: invite.sessionId,
      hostId: invite.hostId,
      self: opts.self,
      link: this.o.link,
      maxPlayers: invite.maxPlayers,
      toGame: (json) => this.frame?.contentWindow?.postMessage(json, this.gameOrigin),
      onResult: (r) => opts.onResult?.(createResultCard(invite, r)),
      onClose: () => this.close(),
    });
    // Listener is ready before the game loads, so its first message is not missed.
    frame.src = url.toString();
    (this.o.container ?? document.body).append(wrapper);
    void this.o.onOpen?.();
  }

  close(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (!s.isClosed) s.close();
    this.wrapper?.remove();
    this.wrapper = null;
    this.frame = null;
    void this.o.onClosed?.();
  }

  destroy(): void {
    this.close();
    window.removeEventListener('message', this.onWindowMessage);
  }

  private onWindowMessage = (e: MessageEvent): void => {
    if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== this.gameOrigin || typeof e.data !== 'string') return;
    this.session?.fromGame(e.data);
  };
}

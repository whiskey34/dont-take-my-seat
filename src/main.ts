import '@fontsource-variable/rubik';
import './ui/styles.css';
import { isSoundEnabled, play, setSoundEnabled, unlockAudio } from './audio/sfx';
import { CONFIG } from './core/config';
import { NO_INPUT, type GameEvent, type GameState, type PlayerSetup } from './core/types';
import { detectLang, getLang, onLangChange, rules, setLang, t, type Lang } from './i18n';
import { Controls } from './input/controls';
import { ClientNet, ClientSession, type CloseReason } from './net/client';
import { botName, HostNet, HostSession } from './net/host';
import { MessengerTransport, findBridge } from './net/messenger';
import { installMockMessenger } from './net/mockMessenger';
import { fetchBoard, hasLeaderboard, reportScore, type Board } from './net/leaderboard';
import { chatPlayerKey, claimPlayerKey } from './net/playerKey';
import { cleanName, type LobbyPlayer } from './net/protocol';
import { RtcHostTransport, RtcJoinTransport, type JoinStage } from './net/rtc/room';
import { LocalSignaling } from './net/signal/local';
import { getIceServers } from './net/rtc/ice';
import { RoomSignaling } from './net/signal/roomSignaling';
import { newRoomCode, normalizeCode, randomId, type Signaling } from './net/signal/signal';
import { PLAYER_COLORS } from './render/palette';
import { TrainScene } from './render/scene';
import { LocalSession, type GameSession } from './session/session';
import { Hud } from './ui/hud';
import { Tips } from './ui/tips';
import { applyPendingUpdate, canInstall, initPwa, install, needsIosHint } from './ui/pwa';
import { loadSettings, saveSettings } from './ui/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const HUMAN = 'you';
/** How long the menu offers to rejoin the last room. */
/** Seconds on the game-over screen before the next game starts by itself. */
const NEXT_GAME_DELAY_S = 8;
const REJOIN_WINDOW_MS = 30 * 60 * 1000;

type Mode = 'menu' | 'lobby' | 'playing' | 'paused' | 'over';
type Screen = 'menu' | 'howto' | 'pause' | 'gameover' | 'settingsScreen' | 'joinScreen' | 'lobby' | 'boardScreen';

/** The multiplayer connection, when there is one. */
type Net =
  | { kind: 'host'; host: HostNet; code: string | null; messenger: MessengerTransport | null }
  | { kind: 'client'; client: ClientNet; code: string | null; messenger: MessengerTransport | null };

function makeSignaling(code: string): Signaling {
  return params.get('signal') === 'local' ? new LocalSignaling(code) : new RoomSignaling(code);
}

function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

class App {
  private readonly scene = new TrainScene($<HTMLCanvasElement>('scene'));
  private readonly hud = new Hud();
  private readonly tipsSeen = new Set<string>();
  private tips!: Tips;
  private tipShown = false;
  private readonly controls = new Controls($('stickZone'), $('stickBase'), $('stickKnob'), $('actionBtn'));
  private settings = loadSettings();
  private mode: Mode = 'menu';
  private session!: GameSession;
  private net: Net | null = null;
  private lobbyPlayers: LobbyPlayer[] = [];
  private last = performance.now();
  /** Games played in a row in this session, and everyone's points when this one began. */
  private gameNo = 1;
  private startScores = new Map<string, number>();
  private nextGameTimer = 0;
  /** Rejoining after the signal dropped; `attempt` tells stale connection attempts apart. */
  private reconnecting = false;
  private resumeAfterOver = false;
  private attempt: symbol | null = null;
  private width = 1;
  private height = 1;
  private seed = (Date.now() & 0x7fffffff) | 1;

  constructor() {
    // ?debug: a live panel with connection and control numbers, and the app in the console.
    if (params.has('debug')) {
      (window as unknown as { __app: unknown }).__app = this;
      this.startDebugPanel();
    }
    setLang(this.settings.lang ?? detectLang(navigator.languages ?? [navigator.language]));
    setSoundEnabled(this.settings.sound);
    this.controls.setSensitivity(this.settings.sensitivity);
    this.applyControlSettings();
    onLangChange(() => this.applyTexts());
    this.applyTexts();
    this.bindUi();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Browsers only allow sound after a tap; players who join from the chat
    // never press "Play", so any tap unlocks it.
    window.addEventListener('pointerdown', () => unlockAudio(), { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'playing') this.pause();
    });
    this.startDemo();
    requestAnimationFrame(this.frame);
    this.startBackgroundTicker();
    this.settings.tipsSeen.forEach((id) => this.tipsSeen.add(id));
    this.tips = new Tips(
      this.tipsSeen,
      () => {
        this.settings.tipsSeen = [...this.tipsSeen];
        saveSettings(this.settings);
      },
      this.scene,
      () => ({ width: this.width, height: this.height }),
    );
    window.setInterval(() => void this.updatePing(), 1000);
    // Updates reload the page, so only apply them while sitting in the main menu.
    initPwa({ isSafeToReload: () => this.mode === 'menu' && !this.net, onInstallChange: () => this.syncInstall() });
    this.syncInstall();
    this.syncRejoin();
    installMockMessenger(params);
    if (findBridge()) void this.openFromMessenger();
  }

  /** This tab's player key (see net/playerKey.ts). */
  private readonly playerKey: Promise<string> = claimPlayerKey(this.settings.playerKey);
  /** Key the leaderboard knows this player by (the chat user's key inside the messenger). */
  private boardKey: Promise<string> = this.playerKey;

  /** Whether friends can currently reach our room (host with a room code). */
  private relayUp: () => boolean = () => true;

  /** Stores a new name everywhere it is shown, and tells the room. */
  private saveName(raw: string): void {
    const name = raw.trim() ? cleanName(raw) : '';
    if (name === this.settings.name) return;
    this.settings.name = name;
    saveSettings(this.settings);
    for (const id of ['inpName', 'inpJoinName', 'inpLobbyName']) {
      const el = $<HTMLInputElement>(id);
      if (document.activeElement !== el) el.value = name;
    }
    const net = this.net;
    if (net?.kind === 'host') net.host.rename(this.name);
    if (net?.kind === 'client') net.client.rename(this.name);
  }

  private get name(): string {
    return this.settings.name || t('namePlaceholder');
  }

  // ---------------------------------------------------------------- sessions

  private nextSeed(): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) & 0x7fffffff;
    return this.seed;
  }

  /** Bots playing behind the menus. */
  private startDemo(): void {
    const seed = this.nextSeed();
    const setups: PlayerSetup[] = Array.from({ length: CONFIG.maxPlayers }, (_, i) => ({ id: `demo${i}`, name: botName(i + 1), isBot: true }));
    this.setSession(new LocalSession(setups, seed, 'normal', null));
  }

  private startLocalGame(scores: ReadonlyMap<string, number> = new Map()): void {
    const seed = this.nextSeed();
    const setups: PlayerSetup[] = [{ id: HUMAN, name: this.name, isBot: false, score: scores.get(HUMAN) ?? 0 }];
    for (let i = 1; setups.length < CONFIG.maxPlayers; i++) {
      const id = `bot${i}`;
      setups.push({ id, name: botName(i), isBot: true, score: scores.get(id) ?? 0 });
    }
    this.beginGame(new LocalSession(setups, seed, this.settings.difficulty, HUMAN));
  }

  private setSession(s: GameSession): void {
    this.session?.dispose();
    this.session = s;
    const view = s.view();
    this.scene.setPlayers(view, s.humanId);
    this.hud.setup(view, s.humanId);
    this.controls.reset();
    this.tips?.clear();
  }

  private beginGame(s: GameSession, resumed = false): void {
    window.clearInterval(this.nextGameTimer);
    this.resumeAfterOver = false;
    // A game that starts from the game-over screen continues the session.
    if (!resumed) this.gameNo = this.mode === 'over' ? this.gameNo + 1 : 1;
    this.startScores = new Map(s.view().players.map((p) => [p.id, p.score]));
    unlockAudio();
    void enterLandscapeFullscreen();
    // Players who joined typed into the code/name fields, and those fields are
    // now hidden. Safari keeps keyboard focus on a hidden field, so the arrow
    // keys never reached the game. Move focus to the game itself.
    (document.activeElement as HTMLElement | null)?.blur?.();
    $('scene').focus({ preventScroll: true });
    this.setSession(s);
    this.mode = 'playing';
    this.show(null);
    this.hud.show(true);
    this.last = performance.now();
  }

  /**
   * Wi-Fi style signal icon next to pause: round-trip time to the host (for a
   * player) or to the slowest player (for the host). Hidden in offline games.
   */
  private async updatePing(): Promise<void> {
    const el = $('hudPing');
    const net = this.net;
    const inGame = this.mode === 'playing' || this.mode === 'paused' || this.mode === 'over';
    const rtt = !inGame || !net ? undefined : net.kind === 'client' ? await net.client.rtt() : await net.host.worstRtt();
    if (rtt === undefined && !this.reconnecting) {
      el.hidden = true;
      return;
    }
    const stalled = this.reconnecting || (this.session instanceof ClientSession && this.session.stalled);
    const level = stalled ? 0 : rtt === null || rtt === undefined ? 2 : rtt < 100 ? 3 : rtt < 200 ? 2 : rtt < 400 ? 1 : 0;
    el.hidden = false;
    el.className = `icon-btn l${level}`;
    $('hudPingMs').textContent = stalled ? '!' : typeof rtt === 'number' ? String(rtt) : '';
    el.title = el.ariaLabel = stalled ? t('weakSignal') : typeof rtt === 'number' ? t('pingMs', { n: rtt }) : '';
  }

  private startDebugPanel(): void {
    const panel = document.createElement('pre');
    panel.id = 'debugPanel';
    document.body.append(panel);
    let frames = 0;
    let route = '?';
    const count = () => {
      frames++;
      requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    window.setInterval(() => {
      if (this.net?.kind === 'client') void this.net.client.route().then((r) => (route = r));
    }, 1000);
    window.setInterval(() => {
      const s = this.session;
      const lines = [`v${__APP_VERSION__} · ${s.kind} · mode ${this.mode} · ${frames * 2} fps`, `stick ${this.controls.peek()}`];
      frames = 0;
      if (s instanceof HostSession) lines.push(...s.debug());
      if (s instanceof ClientSession) {
        lines.push(`route ${route}${this.reconnecting ? ' · reconnecting' : ''}`);
        for (const [k, v] of Object.entries(s.debug())) lines.push(`${k} ${v}`);
      }
      panel.textContent = lines.join('\n');
    }, 500);
  }

  /**
   * The host runs the game for everyone. Browsers stop animation frames in the
   * background (screen dimmed, switched to WhatsApp), which froze every other
   * player in place. A worker timer keeps the host's game ticking meanwhile.
   */
  private startBackgroundTicker(): void {
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }));
      new Worker(url).onmessage = () => this.backgroundTick();
    } catch {
      /* no workers: the game pauses in the background as before */
    }
  }

  private backgroundTick(): void {
    if (!document.hidden || this.session.kind !== 'host') return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const events = this.session.update(dt, NO_INPUT);
    if (events.length) this.onEvents(this.session.view(), events);
  }

  private frame = (now: number) => {
    // The game clock may catch up after a slow frame (up to 0.25 s), so a
    // host on a slow phone does not slow the game down for everyone.
    // Animations still step at most 0.1 s at a time.
    const elapsed = (now - this.last) / 1000;
    const dt = Math.min(0.1, elapsed);
    const simDt = this.session.kind === 'client' ? dt : Math.min(0.25, elapsed);
    this.last = now;
    const networked = this.session.kind !== 'local';
    // A tip card pauses a solo game until "Got it"; multiplayer cannot pause.
    const tipPause = this.tips.blocking && !networked;
    if (this.tips.blocking !== this.tipShown) {
      this.tipShown = this.tips.blocking;
      this.controls.reset(); // no stray push from the key or tap that closed the tip
    }
    const running = (!this.isPortrait() || networked ? this.mode !== 'paused' || networked : false) && !tipPause;
    const input = this.mode === 'playing' && !this.isPortrait() && !tipPause ? this.controls.read() : NO_INPUT;
    const events = running ? this.session.update(simDt, input) : [];
    const view = this.session.view();
    if (this.mode === 'playing' && this.session.humanId) this.tips.watch(view, events, this.session.humanId, !networked);
    // Rejoined while on the results screen and the host has already started the next game.
    if (this.resumeAfterOver && this.session instanceof ClientSession && this.session.hasSnapshot && view.phase !== 'gameOver') {
      this.resumeAfterOver = false;
      window.clearInterval(this.nextGameTimer);
      this.gameNo++;
      this.startScores = new Map(view.players.map((p) => [p.id, p.score]));
      this.mode = 'playing';
      this.show(null);
      this.hud.show(true);
    }
    if (events.length) this.onEvents(view, events);
    // Tell the player why things stopped moving, instead of feeling stuck.
    if (!this.reconnecting && this.session instanceof ClientSession && this.mode === 'playing') this.hud.notice(this.session.stalled ? t('weakSignal') : '');
    this.scene.render(view, running ? dt : 0);
    if (this.mode === 'playing' || this.mode === 'paused' || this.mode === 'over') this.hud.update(view, this.scene, this.width, this.height, this.session.offline?.());
    requestAnimationFrame(this.frame);
  };

  private onEvents(view: GameState, events: GameEvent[]): void {
    this.scene.handleEvents(view, events);
    if (!this.session.humanId) {
      if (view.phase === 'gameOver') this.startDemo();
      return;
    }
    this.hud.handleEvents(view, events);
    const me = this.session.humanId;
    for (const e of events) {
      if (e.type === 'doorsOpen') play('chime');
      if (e.type === 'pushed' && (e.by === me || e.target === me)) play('push');
      if (e.type === 'sat' && e.playerId === me) {
        play('sit');
        this.buzz(15);
      }
      if (e.type === 'seatKick' && (e.by === me || e.target === me)) this.buzz(e.target === me ? [40, 30, 40] : 30);
      if (e.type === 'pushed' && e.target === me) this.buzz(35);
      if (e.type === 'slipped' && e.playerId === me) this.buzz([20, 20, 60]);
      if (e.type === 'kicked' && e.playerId === me) play('kick');
      if (e.type === 'suddenBrake') play('brake');
      if (e.type === 'npcKick' || e.type === 'escorted') play('whistle');
      if (e.type === 'npcKick' && e.playerId === me) this.buzz([60, 40, 60]);
      if (e.type === 'escorted' && e.playerId === me) play('out');
      if (e.type === 'seatMoveWarn') play('tick');
      if (e.type === 'powerUp' && e.playerId === me) play(e.kind === 'mbg' ? 'out' : 'pickup');
      if (e.type === 'powerUp' && e.playerId === me && e.kind === 'mbg') this.buzz([30, 30, 30]);
      if (e.type === 'shielded' && e.playerId === me) play('block');
      if (e.type === 'slept' && e.playerId === me) play('pickup');
      if (e.type === 'eliminated' && e.playerIds.includes(me)) play('out');
      if (e.type === 'winner') {
        if (e.playerId === me) play('win');
        this.postChatResult(view);
        window.setTimeout(() => this.showGameOver(), 900);
      }
    }
  }

  // ---------------------------------------------------------------- multiplayer

  private async createRoom(): Promise<void> {
    if (!('RTCPeerConnection' in window)) return this.notice(t('errNoRtc'));
    void getIceServers(); // fetch TURN credentials while the lobby opens
    const code = newRoomCode(cryptoRandom);
    const signaling = makeSignaling(code);
    this.openLobby({ code, isHost: true, status: t('creatingRoom') });
    try {
      await signaling.ready;
    } catch {
      signaling.close();
      return this.lobbyFailed(t('errNoSignal'));
    }
    if (this.mode !== 'lobby') return signaling.close();
    let host: HostNet | null = null;
    const transport = new RtcHostTransport(signaling, randomId('h'), () => host?.accepting ?? false);
    host = new HostNet(transport, this.name, { lobby: (p) => this.renderLobby(p) });
    this.net = { kind: 'host', host, code, messenger: null };
    // Tell the host when friends cannot reach the room (e.g. right after switching apps).
    if (signaling instanceof RoomSignaling) signaling.onStatus(() => this.renderLobby(this.lobbyPlayers));
    this.relayUp = () => !(signaling instanceof RoomSignaling) || signaling.isUp;
    this.renderLobby(host.players);
  }

  private async joinRoom(raw: string): Promise<void> {
    void getIceServers();
    const code = normalizeCode(raw);
    if (!code) {
      $('joinError').textContent = t('errBadCode');
      return;
    }
    if (!('RTCPeerConnection' in window)) {
      $('joinError').textContent = t('errNoRtc');
      return;
    }
    this.saveName($<HTMLInputElement>('inpJoinName').value);
    // Remember the room so a player who drops out can come straight back.
    this.settings.lastRoom = { code, at: Date.now() };
    saveSettings(this.settings);
    this.openLobby({ code, isHost: false, status: t('connecting') });
    await this.connectClient(code, (stage) => {
      if (this.mode !== 'lobby' || this.lobbyPlayers.length > 0) return;
      $('lobbyStatus').textContent = { searching: t('searchingRoom'), connecting: t('roomFound'), retrying: t('retryingRoom') }[stage];
    });
  }

  /** Finds the room by its code and connects to the host. */
  private async connectClient(code: string, onStage: (stage: JoinStage) => void): Promise<void> {
    const signaling = makeSignaling(code);
    const attempt = Symbol('attempt');
    this.attempt = attempt;
    try {
      await signaling.ready;
    } catch {
      signaling.close();
      if (this.attempt === attempt) this.connectionClosed('unreachable', t('errNoSignal'));
      return;
    }
    // Gave up or left while the relays were connecting.
    if (this.attempt !== attempt || (this.mode !== 'lobby' && !this.reconnecting)) return signaling.close();
    const transport = new RtcJoinTransport(signaling, () => randomId('p'), (reason) => this.connectionClosed(reason), onStage);
    const client = new ClientNet(transport, null, this.name, await this.playerKey, this.clientCallbacks());
    this.net = { kind: 'client', client, code, messenger: null };
  }

  /**
   * Bad signal: the link to the host dropped but the game goes on there.
   * Stay on screen and quietly join again with the same player key; the host
   * puts us back on our character where it is now.
   */
  private reconnect(code: string): void {
    this.reconnecting = true;
    this.net = null;
    this.hud.notice(t('reconnecting'));
    if (this.mode === 'lobby') $('lobbyStatus').textContent = t('reconnecting');
    void this.connectClient(code, () => {});
  }

  /** Launched inside the messenger: the chat decides who plays and who hosts. */
  private async openFromMessenger(): Promise<void> {
    let transport: MessengerTransport;
    try {
      transport = await MessengerTransport.connect(__APP_VERSION__);
    } catch {
      return this.notice(t('errMessenger'));
    }
    const init = transport.init;
    if (!this.settings.lang && init.self.lang) setLang(detectLang([init.self.lang]));
    const myName = cleanName(init.self.name);
    transport.onLifecycle = (state) => {
      if (state === 'background') this.controls.reset();
    };
    const isHost = init.self.id === init.session.hostId;
    this.openLobby({ code: null, isHost, status: isHost ? '' : t('waitingHost') });
    if (isHost) {
      const host = new HostNet(transport, myName, { lobby: (p) => this.renderLobby(p) });
      this.net = { kind: 'host', host, code: null, messenger: transport };
      this.renderLobby(host.players);
    } else {
      this.boardKey = Promise.resolve(chatPlayerKey(init.self.id));
      const client = new ClientNet(transport, init.session.hostId, myName, chatPlayerKey(init.self.id), this.clientCallbacks());
      this.net = { kind: 'client', client, code: null, messenger: transport };
    }
  }

  private clientCallbacks() {
    return {
      lobby: (p: LobbyPlayer[]) => {
        if (this.reconnecting && this.mode === 'lobby') this.reconnecting = false;
        this.renderLobby(p);
      },
      start: (s: GameSession) => this.clientStarted(s),
      closed: (reason: CloseReason) => this.connectionClosed(reason),
    };
  }

  private clientStarted(s: GameSession): void {
    if (!this.reconnecting) return this.beginGame(s);
    this.reconnecting = false;
    this.hud.notice('');
    if (this.mode === 'over') {
      // Back on the results screen: wait for the host's state to see whether a new game began.
      this.setSession(s);
      this.resumeAfterOver = true;
      return;
    }
    this.beginGame(s, true);
  }

  private connectionClosed(reason: CloseReason, message?: string): void {
    const code = this.net?.kind === 'client' && !this.net.messenger ? this.net.code : this.reconnecting ? this.settings.lastRoom?.code ?? null : null;
    const inRoom = this.mode === 'playing' || this.mode === 'paused' || this.mode === 'over' || this.mode === 'lobby';
    // A dropped link (not the host leaving): try again without leaving the game.
    if (reason === 'lost' && code && inRoom && !this.reconnecting) return this.reconnect(code);
    this.reconnecting = false;
    this.resumeAfterOver = false;
    this.attempt = null;
    this.hud.notice('');
    const text =
      message ??
      {
        full: t('errFull'),
        started: t('errStarted'),
        version: t('errVersion'),
        hostLeft: t('errHostLeft'),
        lost: t('errHostLeft'),
        timeout: t('errTimeout'),
        unreachable: t('errUnreachable'),
      }[reason];
    // The room is gone or will not take us back: stop offering to rejoin it.
    if (reason === 'hostLeft' || reason === 'started' || reason === 'full' || reason === 'version' || reason === 'timeout') this.forgetRoom();
    this.net = null;
    if (this.mode === 'lobby') this.lobbyFailed(text);
    else {
      this.toMenu();
      this.notice(text);
    }
  }

  private leaveNet(): void {
    const net = this.net;
    this.net = null;
    if (net?.kind === 'host') net.host.close();
    if (net?.kind === 'client') net.client.leave();
  }

  private openLobby(o: { code: string | null; isHost: boolean; status: string }): void {
    this.mode = 'lobby';
    this.relayUp = () => true;
    $<HTMLInputElement>('inpLobbyName').value = this.name;
    this.hud.show(false);
    this.lobbyPlayers = [];
    $('lobbyCodeBox').hidden = !o.code;
    $('lobbyCode').textContent = o.code ?? '';
    $('lobbyCodeBox').querySelector<HTMLElement>('.tagline')!.hidden = !o.isHost;
    $('btnCopy').hidden = !o.isHost;
    $('lobbyTitle').textContent = o.code ? '' : t('chatPlayers');
    $('lobbyTitle').hidden = !!o.code;
    $('btnLobbyStart').hidden = !o.isHost;
    $<HTMLButtonElement>('btnLobbyStart').disabled = true;
    $('lobbyStatus').textContent = o.status;
    $('lobbyError').textContent = '';
    this.renderLobby([]);
    this.show('lobby');
  }

  private lobbyFailed(text: string): void {
    $('lobbyError').textContent = text;
    $('lobbyStatus').textContent = '';
    $<HTMLButtonElement>('btnLobbyStart').disabled = true;
  }

  private renderLobby(players: LobbyPlayer[]): void {
    this.lobbyPlayers = players;
    const list = $('lobbyList');
    const items: HTMLElement[] = [];
    for (let i = 0; i < CONFIG.maxPlayers; i++) {
      const p = players[i];
      const li = document.createElement('li');
      if (p) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = PLAYER_COLORS[i % PLAYER_COLORS.length]!;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        li.append(dot, name);
        if (i === 0) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = t('host');
          li.append(badge);
        }
      } else {
        li.className = 'empty';
        li.textContent = t('openSpot');
      }
      items.push(li);
    }
    list.replaceChildren(...items);
    const status = $('lobbyStatus');
    status.classList.remove('warn');
    if (this.net?.kind === 'host') {
      const ready = this.net.host.canStart;
      $<HTMLButtonElement>('btnLobbyStart').disabled = !ready;
      const reachable = this.relayUp();
      status.textContent = !reachable ? t('relayDown') : ready ? t('readyToStart') : t('needTwo');
      status.classList.toggle('warn', !reachable);
    } else if (players.length > 0) {
      status.textContent = t('waitingHost');
    }
  }

  private startNetGame(scores: ReadonlyMap<string, number> = new Map()): void {
    if (this.net?.kind !== 'host') return;
    const host = this.net.host;
    if (!host.canStart) return this.backToLobby();
    this.beginGame(host.start(this.settings.difficulty, this.nextSeed(), scores));
  }

  /** Everyone else left after a game: wait in the lobby for friends again. */
  private backToLobby(): void {
    if (this.net?.kind !== 'host') return;
    window.clearInterval(this.nextGameTimer);
    this.net.host.endGame();
    this.mode = 'lobby';
    this.hud.show(false);
    this.show('lobby');
    this.renderLobby(this.net.host.players);
  }

  private postChatResult(view: GameState): void {
    const net = this.net;
    if (net?.kind !== 'host' || !net.messenger) return;
    const winner = view.players.find((p) => p.id === view.winnerId);
    const ranking = [...view.players].sort((a, b) => rankKey(b, view) - rankKey(a, view)).map((p) => p.name);
    net.messenger.postResult(t('chatResult', { name: winner?.name ?? '?' }), winner?.name ?? null, ranking);
  }

  // ---------------------------------------------------------------- screens

  private show(screen: Screen | null): void {
    for (const id of ['menu', 'howto', 'pause', 'gameover', 'settingsScreen', 'joinScreen', 'lobby', 'boardScreen'] as const) $(id).hidden = id !== screen;
  }

  private notice(text: string): void {
    $('menuNotice').textContent = text;
  }

  private pause(): void {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.controls.reset();
    this.show('pause');
  }

  private resume(): void {
    this.mode = 'playing';
    this.last = performance.now();
    this.show(null);
  }

  private toMenu(): void {
    window.clearInterval(this.nextGameTimer);
    this.tips.clear();
    this.reconnecting = false;
    this.resumeAfterOver = false;
    this.attempt = null;
    this.hud.notice('');
    this.leaveNet();
    this.mode = 'menu';
    this.hud.show(false);
    this.show('menu');
    this.startDemo();
    this.syncRejoin();
    applyPendingUpdate();
  }

  /** "Rejoin room ABCDE" in the menu, for a little while after joining a room. */
  private syncRejoin(): void {
    const last = this.settings.lastRoom;
    const fresh = !!last && Date.now() - last.at < REJOIN_WINDOW_MS && params.get('embed') !== 'messenger';
    $('btnRejoin').hidden = !fresh;
    if (fresh && last) $('btnRejoin').textContent = t('rejoinRoom', { code: last.code });
  }

  private forgetRoom(): void {
    this.settings.lastRoom = null;
    saveSettings(this.settings);
    this.syncRejoin();
  }

  private syncInstall(): void {
    const embedded = params.get('embed') === 'messenger';
    $('btnInstall').hidden = embedded || !canInstall();
    $('btnBoard').hidden = !hasLeaderboard();
    $('iosInstallHint').hidden = embedded || !needsIosHint();
  }

  private showGameOver(): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') return;
    this.mode = 'over';
    const g = this.session.view();
    const me = this.session.humanId;
    const winner = g.players.find((p) => p.id === g.winnerId);
    const ranked = [...g.players].sort((a, b) => rankKey(b, g) - rankKey(a, g));
    $('overTitle').textContent = winner?.id === me ? t('youWin') : t('winner', { name: winner?.name ?? '?' });
    $('overPlace').textContent = `${t('gameNumber', { n: this.gameNo })} · ${t('place', { n: ranked.findIndex((p) => p.id === me) + 1 })}`;
    $('standings').replaceChildren(
      ...ranked.map((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!;
        const name = document.createElement('b');
        name.textContent = p.id === me ? t('you') : p.name;
        const gain = document.createElement('span');
        gain.className = 'gain';
        const earned = p.score - (this.startScores.get(p.id) ?? 0);
        gain.textContent = earned > 0 ? t('pointsGained', { n: earned }) : '';
        const pts = document.createElement('span');
        pts.className = 'pts';
        pts.textContent = t('points', { n: p.score });
        li.append(dot, name, pts, gain);
        return li;
      }),
    );
    void this.reportToBoard(g, me);
    const client = this.net?.kind === 'client';
    $('btnAgain').hidden = client;
    $('overWait').hidden = false;
    $('btnMenu').textContent = t('leave');
    this.show('gameover');
    // Keep playing: the next game starts by itself (the host decides in multiplayer).
    if (client) {
      $('overWait').textContent = t('nextGameSoon');
      return;
    }
    let left = NEXT_GAME_DELAY_S;
    const tick = () => {
      $('btnAgain').textContent = `${t('continueNow')} (${left})`;
      $('overWait').textContent = t('nextGameIn', { n: left });
      if (left-- <= 0) this.playAgain();
    };
    tick();
    this.nextGameTimer = window.setInterval(tick, 1000);
  }

  /** Sends this player's points to the shared leaderboard and shows the rank. */
  private async reportToBoard(g: GameState, me: string | null): Promise<void> {
    const el = $('overRank');
    el.hidden = true;
    const p = me ? g.players.find((q) => q.id === me) : undefined;
    if (!p || !hasLeaderboard() || p.score <= 0) return;
    const board = await reportScore(await this.boardKey, p.name, p.score, g.winnerId === p.id);
    if (!board?.me || this.mode !== 'over') return;
    el.textContent = t('yourRank', { n: board.me.rank, total: board.total, best: board.me.score });
    el.hidden = false;
  }

  private async openBoard(): Promise<void> {
    this.show('boardScreen');
    $('boardInfo').textContent = t('loading');
    $('boardList').replaceChildren();
    $('boardMe').hidden = true;
    const board = await fetchBoard(await this.boardKey);
    if (this.mode !== 'menu' || $('boardScreen').hidden) return;
    this.renderBoard(board);
  }

  private renderBoard(board: Board | null): void {
    if (!board) {
      $('boardInfo').textContent = t('boardOffline');
      return;
    }
    $('boardInfo').textContent = board.top.length ? t('boardInfo') : t('boardEmpty');
    const mine = board.me;
    $('boardList').replaceChildren(
      ...board.top.map((r, i) => {
        const li = document.createElement('li');
        if (mine && mine.rank === i + 1) li.className = 'me';
        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = i < 3 ? ['🥇', '🥈', '🥉'][i]! : String(i + 1);
        const name = document.createElement('b');
        name.textContent = r.name;
        const wins = document.createElement('span');
        wins.className = 'wins';
        wins.textContent = t('boardWins', { n: r.wins });
        const pts = document.createElement('span');
        pts.className = 'pts';
        pts.textContent = t('points', { n: r.score });
        li.append(rank, name, wins, pts);
        return li;
      }),
    );
    const me = $('boardMe');
    me.hidden = !mine || mine.rank <= board.top.length;
    if (mine) me.textContent = t('yourRank', { n: mine.rank, total: board.total, best: mine.score });
  }

  private playAgain(): void {
    window.clearInterval(this.nextGameTimer);
    if (this.mode !== 'over') return;
    // Points carry over to the next game.
    const scores = new Map(this.session.view().players.map((p) => [p.id, p.score]));
    if (this.net?.kind === 'host') this.startNetGame(scores);
    else if (!this.net) this.startLocalGame(scores);
  }

  private applyTexts(): void {
    document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
      el.textContent = t(el.dataset.t as Parameters<typeof t>[0]);
    });
    $('rulesList').replaceChildren(...rules().map((r) => Object.assign(document.createElement('li'), { textContent: r })));
    for (const id of ['inpName', 'inpJoinName', 'inpLobbyName']) $<HTMLInputElement>(id).placeholder = t('namePlaceholder');
    document.title = t('title');
    this.syncControls();
    this.syncRejoin();
    if (this.mode === 'lobby') this.renderLobby(this.lobbyPlayers);
  }

  private syncControls(): void {
    const mark = (id: string, value: string) =>
      $(id)
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.v === value));
    mark('segLang', getLang());
    mark('segSound', isSoundEnabled() ? 'on' : 'off');
    mark('segSound2', isSoundEnabled() ? 'on' : 'off');
    mark('segDifficulty', this.settings.difficulty);
    mark('segCtlSize', this.settings.ctlSize);
    mark('segCtlSide', this.settings.ctlSide);
    mark('segCtlMode', this.settings.ctlMode);
    mark('segVibrate', this.settings.vibrate ? 'on' : 'off');
    $('rowVibrate').hidden = !('vibrate' in navigator);
    $<HTMLInputElement>('inpSens').value = String(this.settings.sensitivity);
    $<HTMLInputElement>('inpSens2').value = String(this.settings.sensitivity);
    $<HTMLInputElement>('inpName').value = this.settings.name;
  }

  private applyControlSettings(): void {
    const c = document.body.classList;
    c.toggle('ctl-s', this.settings.ctlSize === 's');
    c.toggle('ctl-l', this.settings.ctlSize === 'l');
    c.toggle('ctl-swap', this.settings.ctlSide === 'right');
    this.controls.setFixed(this.settings.ctlMode === 'fixed');
  }

  /** Short vibration on phones that support it (and when it is switched on). */
  private buzz(ms: number | number[]): void {
    if (!this.settings.vibrate) return;
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* not allowed */
    }
  }

  private save(): void {
    saveSettings(this.settings);
    this.syncControls();
  }

  private bindUi(): void {
    const on = (id: string, fn: () => void) => $(id).addEventListener('click', fn);
    on('btnPlay', () => this.startLocalGame());
    on('btnCreate', () => {
      this.notice('');
      void this.createRoom();
    });
    on('btnRejoin', () => {
      const last = this.settings.lastRoom;
      if (!last) return;
      this.notice('');
      $<HTMLInputElement>('inpJoinName').value = this.settings.name;
      void this.joinRoom(last.code);
    });
    on('btnJoin', () => {
      this.notice('');
      $('joinError').textContent = '';
      $<HTMLInputElement>('inpJoinName').value = this.settings.name;
      this.show('joinScreen');
      $('inpCode').focus();
    });
    on('btnJoinBack', () => this.show('menu'));
    $('joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.joinRoom($<HTMLInputElement>('inpCode').value);
    });
    on('btnLobbyStart', () => this.startNetGame());
    on('btnLobbyLeave', () => this.toMenu());
    on('btnCopy', () => {
      const code = $('lobbyCode').textContent ?? '';
      navigator.clipboard
        ?.writeText(code)
        .then(() => {
          $('btnCopy').textContent = t('copied');
          setTimeout(() => ($('btnCopy').textContent = t('copy')), 1500);
        })
        .catch(() => {});
    });
    on('btnInstall', () => void install());
    on('btnHowTo', () => this.show('howto'));
    on('btnHowToClose', () => this.show('menu'));
    on('btnSettings', () => this.show('settingsScreen'));
    on('btnSettingsClose', () => this.show('menu'));
    on('btnBoard', () => void this.openBoard());
    // Esc pauses (and resumes) a game.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || e.repeat || this.tips.blocking) return;
      if (this.mode === 'playing') this.pause();
      else if (this.mode === 'paused') this.resume();
    });
    on('btnBoardClose', () => this.show('menu'));
    on('btnTipsReset', () => {
      this.tips.reset();
      $('btnTipsReset').textContent = t('tipsReset');
    });
    on('hudPause', () => this.pause());
    on('btnResume', () => this.resume());
    on('btnQuit', () => this.toMenu());
    on('btnAgain', () => this.playAgain());
    on('btnMenu', () => this.toMenu());

    const seg = (id: string, fn: (v: string) => void) =>
      $(id).addEventListener('click', (e) => {
        const v = (e.target as HTMLElement).closest('button')?.dataset.v;
        if (v) {
          fn(v);
          this.save();
        }
      });
    seg('segLang', (v) => {
      this.settings.lang = v as Lang;
      setLang(v as Lang);
    });
    const sound = (v: string) => {
      this.settings.sound = v === 'on';
      setSoundEnabled(this.settings.sound);
      unlockAudio();
    };
    seg('segSound', sound);
    seg('segSound2', sound);
    seg('segDifficulty', (v) => (this.settings.difficulty = v === 'easy' ? 'easy' : 'normal'));
    seg('segCtlSize', (v) => {
      this.settings.ctlSize = v === 's' || v === 'l' ? v : 'm';
      this.applyControlSettings();
    });
    seg('segCtlSide', (v) => {
      this.settings.ctlSide = v === 'right' ? 'right' : 'left';
      this.applyControlSettings();
    });
    seg('segCtlMode', (v) => {
      this.settings.ctlMode = v === 'fixed' ? 'fixed' : 'floating';
      this.applyControlSettings();
    });
    seg('segVibrate', (v) => {
      this.settings.vibrate = v === 'on';
      if (this.settings.vibrate) this.buzz(20);
    });
    for (const id of ['inpSens', 'inpSens2']) {
      $<HTMLInputElement>(id).addEventListener('input', (e) => {
        this.settings.sensitivity = Number((e.target as HTMLInputElement).value);
        this.controls.setSensitivity(this.settings.sensitivity);
        this.save();
      });
    }
    // Names save while typing, from the settings, the join screen or the lobby.
    for (const id of ['inpName', 'inpJoinName', 'inpLobbyName']) {
      const el = $<HTMLInputElement>(id);
      el.addEventListener('input', () => this.saveName(el.value));
      el.addEventListener('change', () => {
        this.saveName(el.value);
        el.value = this.settings.name;
      });
    }
  }

  private resize(): void {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.scene.resize(this.width, this.height);
  }

  private isPortrait(): boolean {
    return this.height > this.width && this.width <= 900;
  }
}

function rankKey(p: GameState['players'][number], g: GameState): number {
  if (p.id === g.winnerId) return 1e6;
  return p.eliminatedInRound ?? 1e5;
}

async function enterLandscapeFullscreen(): Promise<void> {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    /* screen may dim; not critical */
  }
  try {
    if (!document.fullscreenElement && matchMedia('(pointer: coarse)').matches) await document.documentElement.requestFullscreen();
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch {
    /* not supported here: the rotate hint covers it */
  }
}

new App();

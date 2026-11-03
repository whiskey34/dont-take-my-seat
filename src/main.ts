import '@fontsource-variable/rubik';
import './ui/styles.css';
import { isSoundEnabled, play, setSoundEnabled, unlockAudio } from './audio/sfx';
import { CONFIG } from './core/config';
import { NO_INPUT, type GameEvent, type GameState, type PlayerSetup } from './core/types';
import { detectLang, getLang, onLangChange, rules, setLang, t, type Lang } from './i18n';
import { Controls } from './input/controls';
import { ClientNet, type CloseReason } from './net/client';
import { BOT_NAMES, HostNet } from './net/host';
import { MessengerTransport, findBridge } from './net/messenger';
import { installMockMessenger } from './net/mockMessenger';
import { cleanName, type LobbyPlayer } from './net/protocol';
import { RtcHostTransport, RtcJoinTransport } from './net/rtc/room';
import { LocalSignaling } from './net/signal/local';
import { MqttSignaling } from './net/signal/mqtt';
import { newRoomCode, normalizeCode, randomId, type Signaling } from './net/signal/signal';
import { PLAYER_COLORS } from './render/palette';
import { TrainScene } from './render/scene';
import { LocalSession, type GameSession } from './session/session';
import { Hud } from './ui/hud';
import { loadSettings, saveSettings } from './ui/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const HUMAN = 'you';

type Mode = 'menu' | 'lobby' | 'playing' | 'paused' | 'over';
type Screen = 'menu' | 'howto' | 'pause' | 'gameover' | 'settingsScreen' | 'joinScreen' | 'lobby';

/** The multiplayer connection, when there is one. */
type Net =
  | { kind: 'host'; host: HostNet; code: string | null; messenger: MessengerTransport | null }
  | { kind: 'client'; client: ClientNet; code: string | null; messenger: MessengerTransport | null };

function makeSignaling(code: string): Signaling {
  return params.get('signal') === 'local' ? new LocalSignaling(code) : new MqttSignaling(code);
}

function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

class App {
  private readonly scene = new TrainScene($<HTMLCanvasElement>('scene'));
  private readonly hud = new Hud();
  private readonly controls = new Controls($('stickZone'), $('stickBase'), $('stickKnob'), $('actionBtn'));
  private settings = loadSettings();
  private mode: Mode = 'menu';
  private session!: GameSession;
  private net: Net | null = null;
  private lobbyPlayers: LobbyPlayer[] = [];
  private last = performance.now();
  private width = 1;
  private height = 1;
  private seed = (Date.now() & 0x7fffffff) | 1;

  constructor() {
    setLang(this.settings.lang ?? detectLang(navigator.languages ?? [navigator.language]));
    setSoundEnabled(this.settings.sound);
    this.controls.setSensitivity(this.settings.sensitivity);
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
    installMockMessenger(params);
    if (findBridge()) void this.openFromMessenger();
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
    const setups: PlayerSetup[] = BOT_NAMES.slice(0, CONFIG.maxPlayers).map((name, i) => ({ id: `demo${i}`, name, isBot: true }));
    this.setSession(new LocalSession(setups, seed, 'normal', null));
  }

  private startLocalGame(): void {
    const seed = this.nextSeed();
    const setups: PlayerSetup[] = [{ id: HUMAN, name: this.name, isBot: false }];
    const names = BOT_NAMES.filter((n) => n !== this.name);
    for (let i = 1; setups.length < CONFIG.maxPlayers; i++) setups.push({ id: `bot${i}`, name: names[(seed + i) % names.length]!, isBot: true });
    this.beginGame(new LocalSession(setups, seed, this.settings.difficulty, HUMAN));
  }

  private setSession(s: GameSession): void {
    this.session?.dispose();
    this.session = s;
    const view = s.view();
    this.scene.setPlayers(view, s.humanId);
    this.hud.setup(view, s.humanId);
    this.controls.reset();
  }

  private beginGame(s: GameSession): void {
    unlockAudio();
    void enterLandscapeFullscreen();
    this.setSession(s);
    this.mode = 'playing';
    this.show(null);
    this.hud.show(true);
    this.last = performance.now();
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const networked = this.session.kind !== 'local';
    const running = !this.isPortrait() || networked ? this.mode !== 'paused' || networked : false;
    const input = this.mode === 'playing' && !this.isPortrait() ? this.controls.read() : NO_INPUT;
    const events = running ? this.session.update(dt, input) : [];
    const view = this.session.view();
    if (events.length) this.onEvents(view, events);
    this.scene.render(view, running ? dt : 0);
    if (this.mode === 'playing' || this.mode === 'paused' || this.mode === 'over') this.hud.update(view, this.scene, this.width, this.height);
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
      if (e.type === 'sat' && e.playerId === me) play('sit');
      if (e.type === 'kicked' && e.playerId === me) play('kick');
      if (e.type === 'suddenBrake') play('brake');
      if (e.type === 'powerUp' && e.playerId === me) play('pickup');
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
    this.renderLobby(host.players);
  }

  private async joinRoom(raw: string): Promise<void> {
    const code = normalizeCode(raw);
    if (!code) {
      $('joinError').textContent = t('errBadCode');
      return;
    }
    if (!('RTCPeerConnection' in window)) {
      $('joinError').textContent = t('errNoRtc');
      return;
    }
    const signaling = makeSignaling(code);
    this.openLobby({ code, isHost: false, status: t('connecting') });
    try {
      await signaling.ready;
    } catch {
      signaling.close();
      return this.lobbyFailed(t('errNoSignal'));
    }
    if (this.mode !== 'lobby') return signaling.close();
    const transport = new RtcJoinTransport(signaling, randomId('p'), () => this.connectionClosed('timeout'));
    const client = new ClientNet(transport, null, this.name, this.clientCallbacks());
    this.net = { kind: 'client', client, code, messenger: null };
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
      const client = new ClientNet(transport, init.session.hostId, myName, this.clientCallbacks());
      this.net = { kind: 'client', client, code: null, messenger: transport };
    }
  }

  private clientCallbacks() {
    return {
      lobby: (p: LobbyPlayer[]) => this.renderLobby(p),
      start: (s: GameSession) => this.beginGame(s),
      closed: (reason: CloseReason) => this.connectionClosed(reason),
    };
  }

  private connectionClosed(reason: CloseReason): void {
    const text = {
      full: t('errFull'),
      started: t('errStarted'),
      version: t('errVersion'),
      hostLeft: t('errHostLeft'),
      timeout: t('errTimeout'),
    }[reason];
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
    if (this.net?.kind === 'host') {
      $<HTMLButtonElement>('btnLobbyStart').disabled = false;
      $('lobbyStatus').textContent = t('botsFill');
    } else if (players.length > 0) {
      $('lobbyStatus').textContent = t('waitingHost');
    }
  }

  private startNetGame(): void {
    if (this.net?.kind !== 'host') return;
    this.beginGame(this.net.host.start(this.settings.difficulty, this.nextSeed()));
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
    for (const id of ['menu', 'howto', 'pause', 'gameover', 'settingsScreen', 'joinScreen', 'lobby'] as const) $(id).hidden = id !== screen;
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
    this.leaveNet();
    this.mode = 'menu';
    this.hud.show(false);
    this.show('menu');
    this.startDemo();
  }

  private showGameOver(): void {
    if (this.mode !== 'playing' && this.mode !== 'paused') return;
    this.mode = 'over';
    const g = this.session.view();
    const me = this.session.humanId;
    const winner = g.players.find((p) => p.id === g.winnerId);
    const ranked = [...g.players].sort((a, b) => rankKey(b, g) - rankKey(a, g));
    $('overTitle').textContent = winner?.id === me ? t('youWin') : t('winner', { name: winner?.name ?? '?' });
    $('overPlace').textContent = t('place', { n: ranked.findIndex((p) => p.id === me) + 1 });
    $('standings').replaceChildren(
      ...ranked.map((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.style.background = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!;
        li.append(dot, p.id === me ? t('you') : p.name);
        return li;
      }),
    );
    const client = this.net?.kind === 'client';
    $('btnAgain').hidden = client;
    $('overWait').hidden = !client;
    $('overWait').textContent = t('rematchWait');
    $('btnMenu').textContent = this.net ? t('leave') : t('menu');
    this.show('gameover');
  }

  private playAgain(): void {
    if (this.net?.kind === 'host') this.startNetGame();
    else if (!this.net) this.startLocalGame();
  }

  private applyTexts(): void {
    document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
      el.textContent = t(el.dataset.t as Parameters<typeof t>[0]);
    });
    $('rulesList').replaceChildren(...rules().map((r) => Object.assign(document.createElement('li'), { textContent: r })));
    $<HTMLInputElement>('inpName').placeholder = t('namePlaceholder');
    document.title = t('title');
    this.syncControls();
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
    $<HTMLInputElement>('inpSens').value = String(this.settings.sensitivity);
    $<HTMLInputElement>('inpSens2').value = String(this.settings.sensitivity);
    $<HTMLInputElement>('inpName').value = this.settings.name;
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
    on('btnJoin', () => {
      this.notice('');
      $('joinError').textContent = '';
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
    on('btnHowTo', () => this.show('howto'));
    on('btnHowToClose', () => this.show('menu'));
    on('btnSettings', () => this.show('settingsScreen'));
    on('btnSettingsClose', () => this.show('menu'));
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
    for (const id of ['inpSens', 'inpSens2']) {
      $<HTMLInputElement>(id).addEventListener('input', (e) => {
        this.settings.sensitivity = Number((e.target as HTMLInputElement).value);
        this.controls.setSensitivity(this.settings.sensitivity);
        this.save();
      });
    }
    $<HTMLInputElement>('inpName').addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value;
      this.settings.name = v.trim() ? cleanName(v) : '';
      this.save();
    });
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

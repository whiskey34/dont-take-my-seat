import '@fontsource-variable/rubik';
import './ui/styles.css';
import { botThink, createBrain, type BotBrain } from './ai/bot';
import { isSoundEnabled, play, setSoundEnabled, unlockAudio } from './audio/sfx';
import { CONFIG } from './core/config';
import { createGame, step } from './core/game';
import type { GameEvent, GameState, PlayerInput, PlayerSetup } from './core/types';
import { detectLang, getLang, onLangChange, rules, setLang, t, type Lang } from './i18n';
import { Controls } from './input/controls';
import { PLAYER_COLORS } from './render/palette';
import { TrainScene } from './render/scene';
import { Hud } from './ui/hud';
import { loadSettings, saveSettings } from './ui/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const HUMAN = 'you';
const BOT_NAMES = ['Budi', 'Sari', 'Dimas', 'Rina', 'Agus', 'Wulan'];
const DT = 1 / CONFIG.tickRate;

type Mode = 'menu' | 'playing' | 'paused' | 'over';

class App {
  private readonly canvas = $<HTMLCanvasElement>('scene');
  private readonly scene = new TrainScene(this.canvas);
  private readonly hud = new Hud();
  private readonly controls = new Controls($('stickZone'), $('stickBase'), $('stickKnob'), $('actionBtn'));
  private settings = loadSettings();
  private mode: Mode = 'menu';
  private game!: GameState;
  private brains = new Map<string, BotBrain>();
  private humanId: string | null = null;
  private acc = 0;
  private last = performance.now();
  private width = 1;
  private height = 1;
  private seed = (Date.now() & 0x7fffffff) | 1;

  constructor() {
    setLang(this.settings.lang ?? detectLang(navigator.languages ?? [navigator.language]));
    setSoundEnabled(this.settings.sound);
    onLangChange(() => this.applyTexts());
    this.applyTexts();
    this.bindUi();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'playing') this.pause();
    });
    this.startGame(false); // bots-only demo behind the menu
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- game

  private startGame(withHuman: boolean): void {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) & 0x7fffffff;
    const names = shuffle(BOT_NAMES, this.seed);
    const setups: PlayerSetup[] = [];
    if (withHuman) setups.push({ id: HUMAN, name: t('you'), isBot: false });
    while (setups.length < CONFIG.maxPlayers) {
      const name = names[setups.length] ?? `Bot ${setups.length}`;
      setups.push({ id: `bot${setups.length}`, name, isBot: true });
    }
    this.game = createGame(setups, this.seed);
    this.humanId = withHuman ? HUMAN : null;
    this.brains = new Map(
      this.game.players.filter((p) => p.isBot).map((p, i) => [p.id, createBrain(this.seed + i * 7919, withHuman ? this.settings.difficulty : 'normal')]),
    );
    this.scene.setPlayers(this.game, this.humanId);
    this.hud.setup(this.game, this.humanId);
    this.controls.reset();
    this.acc = 0;
  }

  private tick(): GameEvent[] {
    const inputs = new Map<string, PlayerInput>();
    for (const p of this.game.players) {
      if (p.id === this.humanId) inputs.set(p.id, this.controls.read());
      else {
        const brain = this.brains.get(p.id);
        if (brain) inputs.set(p.id, botThink(this.game, p, brain, DT));
      }
    }
    return step(this.game, inputs, DT);
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const running = this.mode === 'menu' || this.mode === 'playing' || this.mode === 'over';
    const events: GameEvent[] = [];
    if (running && !this.isPortrait()) {
      this.acc += dt;
      while (this.acc >= DT) {
        events.push(...this.tick());
        this.acc -= DT;
      }
    }
    if (events.length) this.onEvents(events);
    this.scene.render(this.game, running ? dt : 0);
    if (this.mode !== 'menu') this.hud.update(this.game, this.scene, this.width, this.height);
    requestAnimationFrame(this.frame);
  };

  private onEvents(events: GameEvent[]): void {
    this.scene.handleEvents(this.game, events);
    if (this.mode === 'menu') {
      if (this.game.phase === 'gameOver') this.startGame(false);
      return;
    }
    this.hud.handleEvents(this.game, events);
    const me = this.humanId;
    for (const e of events) {
      if (e.type === 'doorsOpen') play('chime');
      if (e.type === 'pushed' && (e.by === me || e.target === me)) play('push');
      if (e.type === 'sat' && e.playerId === me) play('sit');
      if (e.type === 'kicked' && e.playerId === me) play('kick');
      if (e.type === 'eliminated' && me && e.playerIds.includes(me)) play('out');
      if (e.type === 'winner') {
        if (e.playerId === me) play('win');
        window.setTimeout(() => this.showGameOver(), 900);
      }
    }
  }

  // ---------------------------------------------------------------- screens

  private show(screen: 'menu' | 'howto' | 'pause' | 'gameover' | null): void {
    for (const id of ['menu', 'howto', 'pause', 'gameover']) $(id).hidden = id !== screen;
  }

  private play(): void {
    unlockAudio();
    void enterLandscapeFullscreen();
    this.startGame(true);
    this.mode = 'playing';
    this.show(null);
    this.hud.show(true);
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
    this.mode = 'menu';
    this.hud.show(false);
    this.show('menu');
    this.startGame(false);
  }

  private showGameOver(): void {
    if (this.mode !== 'playing') return;
    this.mode = 'over';
    const g = this.game;
    const winner = g.players.find((p) => p.id === g.winnerId);
    // Ranking: winner first, then whoever lasted longest.
    const ranked = [...g.players].sort((a, b) => rankKey(b, g) - rankKey(a, g));
    const myPlace = ranked.findIndex((p) => p.id === this.humanId) + 1;
    $('overTitle').textContent = winner?.id === this.humanId ? t('youWin') : t('winner', { name: winner?.name ?? '?' });
    $('overPlace').textContent = t('place', { n: myPlace });
    const list = $('standings');
    list.replaceChildren(
      ...ranked.map((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.style.background = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!;
        li.append(dot, p.id === this.humanId ? t('you') : p.name);
        return li;
      }),
    );
    this.show('gameover');
  }

  private applyTexts(): void {
    document.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
      el.textContent = t(el.dataset.t as Parameters<typeof t>[0]);
    });
    const list = $('rulesList');
    list.replaceChildren(...rules().map((r) => Object.assign(document.createElement('li'), { textContent: r })));
    document.title = t('title');
    this.syncToggles();
  }

  private syncToggles(): void {
    const mark = (id: string, value: string) =>
      $(id)
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((b) => b.classList.toggle('on', b.dataset.v === value));
    mark('segLang', getLang());
    mark('segLang2', getLang());
    mark('segSound', isSoundEnabled() ? 'on' : 'off');
    mark('segSound2', isSoundEnabled() ? 'on' : 'off');
    mark('segDifficulty', this.settings.difficulty);
  }

  private bindUi(): void {
    const on = (id: string, fn: () => void) => $(id).addEventListener('click', fn);
    on('btnPlay', () => this.play());
    on('btnHowTo', () => this.show('howto'));
    on('btnHowToClose', () => this.show('menu'));
    on('hudPause', () => this.pause());
    on('btnResume', () => this.resume());
    on('btnQuit', () => this.toMenu());
    on('btnAgain', () => this.play());
    on('btnMenu', () => this.toMenu());

    const seg = (id: string, fn: (v: string) => void) =>
      $(id).addEventListener('click', (e) => {
        const v = (e.target as HTMLElement).closest('button')?.dataset.v;
        if (v) {
          fn(v);
          saveSettings(this.settings);
          this.syncToggles();
        }
      });
    const lang = (v: string) => {
      this.settings.lang = v as Lang;
      setLang(v as Lang);
    };
    const sound = (v: string) => {
      this.settings.sound = v === 'on';
      setSoundEnabled(this.settings.sound);
      unlockAudio();
    };
    seg('segLang', lang);
    seg('segLang2', lang);
    seg('segSound', sound);
    seg('segSound2', sound);
    seg('segDifficulty', (v) => (this.settings.difficulty = v === 'easy' ? 'easy' : 'normal'));
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

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
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

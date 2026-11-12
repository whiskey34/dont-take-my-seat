import { CONFIG } from '../core/config';
import { canUseItem, isFinalStop, kickBeatsSitting, npcKickSeat, pushTarget, seatInReach, seatKickTarget, trainAccel } from '../core/game';
import type { GameEvent, GameState, Player } from '../core/types';
import { t } from '../i18n';
import { PLAYER_COLORS } from '../render/palette';
import { ITEM_ICON } from '../shop/catalog';
import type { TrainScene } from '../render/scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PHASE_LENGTH: Record<string, number> = {
  intro: CONFIG.phase.intro,
  riding: CONFIG.phase.riding,
  scramble: CONFIG.phase.scramble,
  result: CONFIG.phase.result,
};

/** In-game overlay: station board, roster, banners, name tags, action button. */
export class Hud {
  private readonly root = $('hud');
  private readonly rosterBox = $('roster');
  private readonly roster = $('rosterFull');
  private readonly rosterMini = $('rosterMini');
  private readonly miniDots = new Map<string, HTMLElement>();
  private rosterTimer = 0;
  private rosterDownAt = 0;
  private rosterByPointer = false;
  private readonly board = $('board');
  private readonly boardLabel = $('boardLabel');
  private readonly boardStation = $('boardStation');
  private readonly boardChallenge = $('boardChallenge');
  private readonly timerFill = $('timerFill');
  private readonly seatsLeft = $('seatsLeft');
  private readonly banner = $('banner');
  private readonly labels = $('labels');
  private readonly actionBtn = $('actionBtn');
  private readonly itemBtn = $('itemBtn');
  private readonly itemIcon = $('itemIcon');
  private readonly actionLabel = $('actionLabel');
  private readonly actionRing = document.querySelector<SVGCircleElement>('#actionRing circle');
  private chips = new Map<string, HTMLElement>();
  private tags = new Map<string, HTMLElement>();
  private bannerTimer = 0;
  private humanId: string | null = null;

  constructor() {
    // The player list stays small; hold Tab (keyboard) or touch it to see everyone.
    this.rosterMini.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const wasOpen = this.rosterBox.classList.contains('open');
      window.clearTimeout(this.rosterTimer);
      if (wasOpen && !this.rosterByPointer) return;
      if (wasOpen) return this.openRoster(false);
      this.rosterByPointer = true;
      this.rosterDownAt = performance.now();
      this.openRoster(true);
    });
    window.addEventListener('pointerup', () => {
      if (!this.rosterByPointer || !this.rosterBox.classList.contains('open')) return;
      // A long press closes on release; a quick tap keeps it open for a moment.
      if (performance.now() - this.rosterDownAt > 300) this.openRoster(false);
      else this.rosterTimer = window.setTimeout(() => this.openRoster(false), 3000);
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Tab' || this.root.hidden) return;
        e.preventDefault();
        if (!e.repeat) this.openRoster(true);
      },
      true,
    );
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.openRoster(false);
    });
    window.addEventListener('blur', () => this.openRoster(false));
  }

  private openRoster(open: boolean): void {
    window.clearTimeout(this.rosterTimer);
    if (!open) this.rosterByPointer = false;
    this.rosterBox.classList.toggle('open', open);
    this.rosterMini.setAttribute('aria-expanded', String(open));
  }

  /** Connection notice above everything (e.g. rejoining after the signal dropped); '' hides it. */
  notice(text: string): void {
    const el = $('netNotice');
    if (el.textContent === text && el.hidden === !text) return;
    el.textContent = text;
    el.hidden = !text;
  }

  show(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Builds the roster and name tags for a new game. */
  setup(state: GameState, humanId: string | null): void {
    this.humanId = humanId;
    this.roster.replaceChildren();
    this.labels.replaceChildren();
    this.chips.clear();
    this.miniDots.clear();
    const dots = this.rosterMini.querySelector('.mdots') as HTMLElement;
    dots.replaceChildren();
    this.rosterMini.setAttribute('aria-label', t('playersHold'));
    this.openRoster(false);
    this.tags.clear();
    for (const p of state.players) {
      const color = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!;
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<span class="dot"></span><span class="name"></span><span class="pts"></span><span class="state"></span>';
      (chip.querySelector('.dot') as HTMLElement).style.background = color;
      this.roster.append(chip);
      this.chips.set(p.id, chip);
      const dot = document.createElement('span');
      dot.className = p.id === humanId ? 'mdot me' : 'mdot';
      dot.style.background = color;
      dots.append(dot);
      this.miniDots.set(p.id, dot);

      const tag = document.createElement('div');
      tag.className = p.id === humanId ? 'tag me' : 'tag';
      tag.style.background = color;
      tag.style.borderTopColor = color;
      this.labels.append(tag);
      this.tags.set(p.id, tag);
    }
    this.flash('', 'none', 0);
  }

  handleEvents(state: GameState, events: readonly GameEvent[]): void {
    const me = this.humanId;
    for (const e of events) {
      switch (e.type) {
        case 'doorsOpen':
          this.flash(t('doorsOpen'), 'good', 1400);
          break;
        case 'sat':
          if (e.playerId === me) this.flash(t('youSat'), 'good', 1100);
          break;
        case 'kicked':
          if (e.playerId === me) this.flash(t('kicked'), 'bad', 1500);
          break;
        case 'eliminated': {
          if (me && e.playerIds.includes(me)) {
            this.flash(t('youAreOut'), 'bad', 2200);
          } else {
            const names = e.playerIds.map((id) => state.players.find((p) => p.id === id)?.name ?? id).join(', ');
            this.flash(t('outOthers', { names }), 'plain', 1800);
          }
          break;
        }
        case 'challenge':
          this.flash(challengeText(state), 'warn', 2200);
          break;
        case 'suddenBrake':
          this.flash(t('brakeNow'), 'bad', 1200);
          break;
        case 'powerUp':
          if (e.playerId === me) this.flash(e.kind === 'earphones' ? t('gotEarphones') : e.kind === 'coffee' ? t('gotCoffee') : e.kind === 'mbg' ? t('gotMbg') : t('gotSleep'), e.kind === 'mbg' ? 'bad' : 'good', 1800);
          break;
        case 'shielded':
          if (e.playerId === me) this.flash(t('shieldBlocked'), 'good', 1000);
          break;
        case 'slept':
          if (e.playerId === me) this.flash(t('sleptSafe'), 'good', 1600);
          break;
        case 'slipped':
          if (e.playerId === me) this.flash(t('youSlipped'), 'bad', 1200);
          break;
        case 'seatKick': {
          const name = (id: string) => state.players.find((p) => p.id === id)?.name ?? id;
          if (e.by === me) this.flash(t('youKicked', { name: name(e.target), n: CONFIG.points.kick }), 'good', 1600);
          else if (e.target === me) this.flash(t('gotKicked', { name: name(e.by) }), 'bad', 1600);
          break;
        }
        case 'seatMoveWarn':
          this.flash(t('seatMoveWarn'), 'warn', 1500);
          break;
        case 'seatMoved': {
          const mine = state.players.find((p) => p.id === me);
          if (mine && mine.seatId !== null && e.seatIds.includes(mine.seatId)) this.flash(t('seatMovedMine'), 'bad', 1800);
          break;
        }
        case 'npcKick': {
          if (e.strike >= 2) break; // 'escorted' says it
          const name = state.players.find((p) => p.id === e.playerId)?.name ?? e.playerId;
          if (e.playerId === me) this.flash(t('npcKick1', { n: CONFIG.challenge.npcKickPenalty }), 'bad', 2400);
          else this.flash(t('npcKickOther', { name }), 'plain', 1800);
          break;
        }
        case 'escorted': {
          const name = state.players.find((p) => p.id === e.playerId)?.name ?? e.playerId;
          this.flash(e.playerId === me ? t('escortedMe') : t('escortedOther', { name }), e.playerId === me ? 'bad' : 'plain', 2600);
          break;
        }
        case 'points': {
          const chip = this.chips.get(e.playerId);
          const pts = chip?.querySelector<HTMLElement>('.pts');
          if (pts) {
            pts.classList.remove('bump');
            void pts.offsetWidth; // restart the animation
            pts.classList.add('bump');
          }
          break;
        }
        case 'itemUsed':
          if (e.playerId === me) this.flash(`${ITEM_ICON[e.kind]} ${t(`itemUsed_${e.kind}`)}`, 'good', 1500);
          break;
        case 'replay':
          this.flash(t('replay'), 'plain', 2000);
          break;
        case 'restart':
          this.flash(t('allCaught', { n: e.penalty }), 'bad', 3200);
          break;
        default:
          break;
      }
    }
  }

  private phaseKey = '';
  private phaseTotal = 0;

  private flash(text: string, kind: 'good' | 'bad' | 'warn' | 'plain' | 'none', ms: number): void {
    window.clearTimeout(this.bannerTimer);
    this.banner.textContent = text;
    this.banner.className = kind === 'none' ? '' : `show ${kind}`;
    if (ms > 0) this.bannerTimer = window.setTimeout(() => (this.banner.className = ''), ms);
  }

  update(state: GameState, scene: TrainScene, width: number, height: number, offline: ReadonlySet<string> = new Set()): void {
    // Station board.
    const braking = state.phase === 'riding' && trainAccel(state).x > 0;
    const label =
      state.phase === 'intro' ? t('getReady') : braking || state.phase === 'scramble' || state.phase === 'result' ? t('arrivingAt') : t('nextStation');
    this.boardLabel.textContent = label;
    this.boardStation.textContent = state.station;
    const ch = state.phase === 'riding' || state.phase === 'scramble' ? challengeText(state) : '';
    this.boardChallenge.textContent = ch;
    this.boardChallenge.hidden = !ch;
    this.board.classList.toggle('scramble', state.phase === 'scramble');
    this.board.classList.toggle('rush', state.challenge === 'rushHour' && (state.phase === 'riding' || state.phase === 'scramble'));
    // Special events make the scramble longer than usual.
    const key = `${state.phase}:${state.round}`;
    if (key !== this.phaseKey) {
      this.phaseKey = key;
      this.phaseTotal = Math.max(PHASE_LENGTH[state.phase] ?? 0, Number.isFinite(state.phaseEndsAt) ? state.phaseEndsAt - state.time : 0);
    }
    const total = this.phaseTotal;
    const left = total ? Math.max(0, state.phaseEndsAt - state.time) / total : 0;
    this.timerFill.style.transform = `scaleX(${left.toFixed(3)})`;

    // Seats left.
    const open = state.freeSeatIds.filter((id) => state.seats[id]?.playerId === null).length;
    this.seatsLeft.classList.toggle('show', state.phase === 'scramble' && open > 0);
    this.seatsLeft.textContent = open === 1 ? t('seatLeft') : t('seatsLeft', { n: open });

    // Roster and tags.
    for (const p of state.players) {
      const chip = this.chips.get(p.id);
      if (chip) {
        const away = offline.has(p.id) && !p.eliminated;
        chip.classList.toggle('out', p.eliminated);
        chip.classList.toggle('offline', away);
        chip.classList.toggle('seated', p.seatId !== null && !p.eliminated);
        (chip.querySelector('.name') as HTMLElement).textContent = this.tagText(p, state.time);
        (chip.querySelector('.pts') as HTMLElement).textContent = String(p.score);
        (chip.querySelector('.state') as HTMLElement).textContent = p.eliminated ? t('out') : away ? t('offline') : p.seatId !== null ? t('seated') : t('standing');
      }
      const dot = this.miniDots.get(p.id);
      if (dot) {
        dot.classList.toggle('out', p.eliminated);
        dot.classList.toggle('offline', offline.has(p.id) && !p.eliminated);
        dot.classList.toggle('seated', p.seatId !== null && !p.eliminated);
        if (p.id === this.humanId) (this.rosterMini.querySelector('.mpts') as HTMLElement).textContent = String(p.score);
      }
      const tag = this.tags.get(p.id);
      if (tag) {
        const pos = scene.labelPos(state, p.id, width, height);
        tag.hidden = !pos;
        if (pos) {
          tag.textContent = this.tagText(p, state.time) + (offline.has(p.id) ? ' ⚠' : '');
          tag.classList.toggle('offline', offline.has(p.id));
          tag.style.left = `${pos.x}px`;
          tag.style.top = `${pos.y}px`;
        }
      }
    }

    this.updateAction(state);
  }

  private displayName(p: Player): string {
    return p.id === this.humanId ? t('you') : p.name;
  }

  /** Name plus icons for active power-ups. */
  private tagText(p: Player, time: number): string {
    const icons = (time < p.shieldUntil ? ' 🎧' : '') + (time < p.boostUntil ? ' 🧋' : '') + (time < p.sickUntil ? ' 🤢' : '') + (p.sleeping ? ' 💤' : '');
    return this.displayName(p) + icons;
  }

  /** The shop item button: shown while we still carry an item; dim while it can't be used. */
  private updateItem(state: GameState): void {
    const me = state.players.find((p) => p.id === this.humanId);
    const show = !!me && !!me.item && !me.eliminated && (state.phase === 'riding' || state.phase === 'scramble');
    this.itemBtn.classList.toggle('hidden', !show);
    if (!me || !show || !me.item) return;
    this.itemIcon.textContent = ITEM_ICON[me.item];
    this.itemBtn.setAttribute('aria-label', t(`item_${me.item}`));
    this.itemBtn.classList.toggle('cooling', !canUseItem(state, me));
  }

  private updateAction(state: GameState): void {
    this.updateItem(state);
    const me = state.players.find((p) => p.id === this.humanId);
    const active = !!me && !me.eliminated && me.seatId === null && (state.phase === 'riding' || state.phase === 'scramble');
    this.actionBtn.classList.toggle('hidden', !active);
    if (!me || !active) return;
    const free = seatInReach(state, me);
    const kickFirst = !!free && kickBeatsSitting(state, me, free);
    const canSit = !!free && !kickFirst;
    const canKick = !canSit && (!!seatKickTarget(state, me) || (!!npcKickSeat(state, me) && !pushTarget(state, me)));
    this.actionBtn.classList.toggle('sit', canSit);
    this.actionBtn.classList.toggle('kick', canKick);
    this.actionLabel.textContent = canSit ? t('sit') : canKick || state.challenge === 'kickFight' ? t('kick') : t('push');
    const full = me.pushReadyAt - state.time > CONFIG.push.cooldown ? CONFIG.challenge.kickCooldown : CONFIG.push.cooldown;
    const cooldownLeft = Math.max(0, me.pushReadyAt - state.time) / full;
    const cooling = !canSit && cooldownLeft > 0;
    this.actionBtn.classList.toggle('cooling', cooling || (!canSit && !canKick && !pushTarget(state, me)));
    if (this.actionRing) this.actionRing.style.strokeDashoffset = String(289 * (1 - (cooling ? cooldownLeft : 0)));
  }
}

/** The current stop's challenge, as shown on the station board. */
export function challengeText(state: GameState): string {
  if (isFinalStop(state)) return t('finalStop');
  switch (state.challenge) {
    case 'suddenBrake':
      return t('chBrake');
    case 'crowd':
      return t('chCrowd');
    case 'oneSideDoors':
      return state.doorSide === -1 ? t('chDoorsLeft') : t('chDoorsRight');
    case 'kickFight':
      return t('chKick');
    case 'puddles':
      return t('chPuddles');
    case 'rushHour':
      return t('chRush');
    default:
      return '';
  }
}

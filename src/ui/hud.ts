import { CONFIG } from '../core/config';
import { pushTarget, seatInReach, trainAccel } from '../core/game';
import type { GameEvent, GameState, Player } from '../core/types';
import { t } from '../i18n';
import { PLAYER_COLORS } from '../render/palette';
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
  private readonly roster = $('roster');
  private readonly board = $('board');
  private readonly boardLabel = $('boardLabel');
  private readonly boardStation = $('boardStation');
  private readonly boardChallenge = $('boardChallenge');
  private readonly timerFill = $('timerFill');
  private readonly seatsLeft = $('seatsLeft');
  private readonly banner = $('banner');
  private readonly labels = $('labels');
  private readonly actionBtn = $('actionBtn');
  private readonly actionLabel = $('actionLabel');
  private readonly actionRing = document.querySelector<SVGCircleElement>('#actionRing circle');
  private chips = new Map<string, HTMLElement>();
  private tags = new Map<string, HTMLElement>();
  private bannerTimer = 0;
  private humanId: string | null = null;

  show(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Builds the roster and name tags for a new game. */
  setup(state: GameState, humanId: string | null): void {
    this.humanId = humanId;
    this.roster.replaceChildren();
    this.labels.replaceChildren();
    this.chips.clear();
    this.tags.clear();
    for (const p of state.players) {
      const color = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!;
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<span class="dot"></span><span class="name"></span><span class="state"></span>';
      (chip.querySelector('.dot') as HTMLElement).style.background = color;
      this.roster.append(chip);
      this.chips.set(p.id, chip);

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
          if (e.playerId === me) this.flash(e.kind === 'earphones' ? t('gotEarphones') : t('gotSleep'), 'good', 1800);
          break;
        case 'shielded':
          if (e.playerId === me) this.flash(t('shieldBlocked'), 'good', 1000);
          break;
        case 'slept':
          if (e.playerId === me) this.flash(t('sleptSafe'), 'good', 1600);
          break;
        case 'replay':
          this.flash(t('replay'), 'plain', 2000);
          break;
        default:
          break;
      }
    }
  }

  private flash(text: string, kind: 'good' | 'bad' | 'warn' | 'plain' | 'none', ms: number): void {
    window.clearTimeout(this.bannerTimer);
    this.banner.textContent = text;
    this.banner.className = kind === 'none' ? '' : `show ${kind}`;
    if (ms > 0) this.bannerTimer = window.setTimeout(() => (this.banner.className = ''), ms);
  }

  update(state: GameState, scene: TrainScene, width: number, height: number): void {
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
    const total = PHASE_LENGTH[state.phase];
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
        chip.classList.toggle('out', p.eliminated);
        chip.classList.toggle('seated', p.seatId !== null && !p.eliminated);
        (chip.querySelector('.name') as HTMLElement).textContent = this.tagText(p, state.time);
        (chip.querySelector('.state') as HTMLElement).textContent = p.eliminated ? t('out') : p.seatId !== null ? t('seated') : t('standing');
      }
      const tag = this.tags.get(p.id);
      if (tag) {
        const pos = scene.labelPos(state, p.id, width, height);
        tag.hidden = !pos;
        if (pos) {
          tag.textContent = this.tagText(p, state.time);
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
    const icons = (time < p.shieldUntil ? ' 🎧' : '') + (p.sleeping ? ' 💤' : '');
    return this.displayName(p) + icons;
  }

  private updateAction(state: GameState): void {
    const me = state.players.find((p) => p.id === this.humanId);
    const active = !!me && !me.eliminated && me.seatId === null && (state.phase === 'riding' || state.phase === 'scramble');
    this.actionBtn.classList.toggle('hidden', !active);
    if (!me || !active) return;
    const canSit = !!seatInReach(state, me);
    this.actionBtn.classList.toggle('sit', canSit);
    this.actionLabel.textContent = canSit ? t('sit') : t('push');
    const cooldownLeft = Math.max(0, me.pushReadyAt - state.time) / CONFIG.push.cooldown;
    const cooling = !canSit && cooldownLeft > 0;
    this.actionBtn.classList.toggle('cooling', cooling || (!canSit && !pushTarget(state, me)));
    if (this.actionRing) this.actionRing.style.strokeDashoffset = String(289 * (1 - (cooling ? cooldownLeft : 0)));
  }
}

/** The current stop's challenge, as shown on the station board. */
export function challengeText(state: GameState): string {
  switch (state.challenge) {
    case 'suddenBrake':
      return t('chBrake');
    case 'crowd':
      return t('chCrowd');
    case 'oneSideDoors':
      return state.doorSide === -1 ? t('chDoorsLeft') : t('chDoorsRight');
    default:
      return '';
  }
}

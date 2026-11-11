import { isFinalStop, seatsThisStop, alivePlayers } from '../core/game';
import type { GameEvent, GameState } from '../core/types';
import { t } from '../i18n';
import type { TrainScene } from '../render/scene';

/**
 * Tips, like mobile games: the first time in a game that an item, a challenge
 * or a rule shows up, a short card points at it. Playing alone the game pauses
 * until "Got it"; in multiplayer (which cannot pause) a small bubble shows
 * for 2 seconds. On by default, every game; can be turned off in the settings.
 */
export type TipId =
  | 'coffee'
  | 'mbg'
  | 'earphones'
  | 'sleep'
  | 'suddenBrake'
  | 'crowd'
  | 'oneSideDoors'
  | 'kickFight'
  | 'puddles'
  | 'rushHour'
  | 'seatMove'
  | 'npcKick'
  | 'priority'
  | 'warmup'
  | 'seatsShort'
  | 'finalStop';

export const TIP_IDS: readonly TipId[] = [
  'coffee',
  'mbg',
  'earphones',
  'sleep',
  'suddenBrake',
  'crowd',
  'oneSideDoors',
  'kickFight',
  'puddles',
  'rushHour',
  'seatMove',
  'npcKick',
  'priority',
  'warmup',
  'seatsShort',
  'finalStop',
];

type Anchor = { world: { x: number; y: number; z: number } } | { el: string };

interface Tip {
  id: TipId;
  anchor: Anchor;
}

const KIND: Record<TipId, 'item' | 'challenge' | 'rule'> = {
  coffee: 'item',
  mbg: 'item',
  earphones: 'item',
  sleep: 'item',
  suddenBrake: 'challenge',
  crowd: 'challenge',
  oneSideDoors: 'challenge',
  kickFight: 'challenge',
  puddles: 'challenge',
  rushHour: 'challenge',
  seatMove: 'challenge',
  npcKick: 'rule',
  priority: 'rule',
  warmup: 'rule',
  seatsShort: 'rule',
  finalStop: 'rule',
};

const COFFEE_ICON =
  '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M5.5 6.5h13l-1.6 14.2a1.5 1.5 0 0 1-1.5 1.3H8.6a1.5 1.5 0 0 1-1.5-1.3z" fill="#fff" stroke="#c9b9a6" stroke-width="1"/><path d="M6.6 10h10.8l-1.2 10.5a1 1 0 0 1-1 .9H8.8a1 1 0 0 1-1-.9z" fill="#c08552"/><path d="M7.7 19h8.6l-.2 1.5a1 1 0 0 1-1 .9H8.9a1 1 0 0 1-1-.9z" fill="#5a3620"/><rect x="8.2" y="8.6" width="3" height="2.8" rx=".6" fill="#eaf7ff" transform="rotate(-12 9.7 10)"/><rect x="12.6" y="8.9" width="3" height="2.8" rx=".6" fill="#eaf7ff" transform="rotate(14 14.1 10.3)"/><rect x="4.8" y="5.3" width="14.4" height="1.6" rx=".8" fill="#e6dccf"/></svg>';

const ICON: Record<TipId, string> = {
  coffee: COFFEE_ICON,
  mbg: '🍱',
  earphones: '🎧',
  sleep: '💤',
  suddenBrake: '⚠️',
  crowd: '👥',
  oneSideDoors: '🚪',
  kickFight: '🦶',
  puddles: '💧',
  rushHour: '🚨',
  seatMove: '🔴',
  npcKick: '👮',
  priority: '🪑',
  warmup: '🪑',
  seatsShort: '🪑',
  finalStop: '🏁',
};

const BUBBLE_MS = 2000;

export class Tips {
  private readonly queue: Tip[] = [];
  private current: Tip | null = null;
  private bubbleTimer = 0;
  private readonly root: HTMLElement;
  /** Ids queued during this game, so a tip is not queued twice before it shows. */
  private readonly pending = new Set<TipId>();

  constructor(
    private readonly enabled: () => boolean,
    private readonly scene: TrainScene,
    private readonly size: () => { width: number; height: number },
  ) {
    this.root = document.createElement('div');
    this.root.id = 'tips';
    document.getElementById('app')?.append(this.root);
  }

  /** True while a card waits for "Got it" (the solo game is paused meanwhile). */
  get blocking(): boolean {
    return this.current !== null && this.mode === 'card';
  }

  private mode: 'card' | 'bubble' = 'card';

  /** New game, or left a game: drop anything on screen. */
  clear(): void {
    this.queue.length = 0;
    this.pending.clear();
    this.close();
  }

  /** Looks at what happened this frame and queues tips for things seen the first time. */
  watch(state: GameState, events: readonly GameEvent[], humanId: string | null, canPause: boolean): void {
    this.mode = canPause ? 'card' : 'bubble';
    const me = humanId ? state.players.find((p) => p.id === humanId) : undefined;
    if (!me || me.eliminated) return;
    for (const e of events) {
      if (e.type === 'challenge') {
        if (isFinalStop(state)) this.add('finalStop', { el: 'board' });
        const ch = e.kind;
        if (ch === 'puddles' && state.puddles[0]) this.add('puddles', { world: { x: state.puddles[0].x, y: 0, z: state.puddles[0].z } });
        else if ((ch === 'crowd' || ch === 'rushHour') && state.standers[0]) this.add(ch, { world: { ...xz(state.standers[0].pos), y: 1 } });
        else this.add(ch, { el: 'board' });
      }
      if (e.type === 'doorsOpen') {
        const alive = alivePlayers(state).length;
        if (seatsThisStop(state) >= alive) this.add('warmup', { el: 'seatsLeft' });
        else if (!isFinalStop(state)) this.add('seatsShort', { el: 'seatsLeft' });
        const trap = state.trapSeatId === null ? undefined : state.seats[state.trapSeatId];
        if (trap) this.add('priority', { world: { x: trap.x, y: 0.7, z: trap.side * 1.85 } });
        // Seated passengers can be kicked off (at a cost): explain once, the first time it matters.
        const npc = state.seats.find((seat) => seat.npc && !seat.priority);
        if (npc && !isFinalStop(state) && seatsThisStop(state) < alive) this.add('npcKick', { world: { x: npc.x, y: 0.9, z: npc.side * 1.85 } });
      }
      if (e.type === 'seatMoveWarn') {
        const seat = state.seats[e.seatIds[0] ?? -1];
        if (seat) this.add('seatMove', { world: { x: seat.x, y: 0.7, z: seat.side * 1.85 } });
      }
    }
    // Items: the first time each kind lies on the floor.
    for (const u of state.powerUps) this.add(u.kind, { world: { ...xz(u.pos), y: 0.55 } });
    if (!this.current) this.next();
  }

  private add(id: TipId, anchor: Anchor): void {
    if (!this.enabled() || this.pending.has(id)) return;
    this.pending.add(id);
    this.queue.push({ id, anchor });
  }

  private next(): void {
    const tip = this.queue.shift();
    if (!tip) return;
    this.current = tip;
    this.render(tip);
  }

  /** Enter or Space also closes the card (keyboard players). */
  private readonly onKey = (e: KeyboardEvent) => {
    if (this.mode !== 'card' || !this.current) return;
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Esc closes the tip without also pausing
      this.done();
    }
  };

  private close(): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.clearTimeout(this.bubbleTimer);
    this.current = null;
    this.root.replaceChildren();
    this.root.className = '';
  }

  private done = () => {
    this.close();
    this.next();
  };

  private render(tip: Tip): void {
    const { width, height } = this.size();
    const at = this.anchorPos(tip.anchor, width, height);
    const icon = `<div class="tipIcon">${ICON[tip.id]}</div>`;
    const title = t(`tip_${tip.id}_t` as Parameters<typeof t>[0]);
    const body = t(`tip_${tip.id}_b` as Parameters<typeof t>[0]);
    this.root.style.setProperty('--x', `${at.x}px`);
    this.root.style.setProperty('--y', `${at.y}px`);
    this.root.style.setProperty('--r', `${at.r}px`);
    if (this.mode === 'card') {
      this.root.className = 'card';
      const kicker = t(KIND[tip.id] === 'item' ? 'tipNewItem' : KIND[tip.id] === 'challenge' ? 'tipChallenge' : 'tipRule');
      this.root.innerHTML = `<div class="tipScrim"></div><div class="tipRing"></div>
        <div class="tipCard" role="dialog" aria-live="polite">
          <div class="tipHead">${icon}<div><div class="tipKicker">${kicker}</div><div class="tipTitle"></div></div></div>
          <p class="tipBody"></p><p class="tipHint">${t('tipOff')}</p>
          <button class="tipBtn">${t('tipOk')}</button>
        </div>`;
      this.root.querySelector('.tipTitle')!.textContent = title;
      this.root.querySelector('.tipBody')!.innerHTML = body; // our own strings, may contain <b>
      const card = this.root.querySelector<HTMLElement>('.tipCard')!;
      placeCard(card, at, width, height);
      const btn = this.root.querySelector<HTMLButtonElement>('.tipBtn')!;
      btn.addEventListener('click', this.done);
      btn.focus({ preventScroll: true });
      window.addEventListener('keydown', this.onKey, true);
    } else {
      this.root.className = 'bubble';
      this.root.innerHTML = `<div class="tipRing"></div><div class="tipBubble">${icon}<div><b></b> <span></span></div></div>`;
      this.root.querySelector('.tipBubble b')!.textContent = `${title}:`;
      this.root.querySelector('.tipBubble span')!.textContent = t(`tip_${tip.id}_s` as Parameters<typeof t>[0]);
      placeBubble(this.root.querySelector<HTMLElement>('.tipBubble')!, at, width);
      this.bubbleTimer = window.setTimeout(this.done, BUBBLE_MS);
    }
  }

  private anchorPos(a: Anchor, width: number, height: number): { x: number; y: number; r: number } {
    if ('el' in a) {
      const el = document.getElementById(a.el);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.min(Math.max(r.width, r.height) / 2 + 10, 72) };
      return { x: width / 2, y: 60, r: 70 };
    }
    const p = this.scene.project(a.world.x, a.world.y, a.world.z, width, height);
    return { ...p, r: 50 };
  }
}

const xz = (p: { x: number; z: number }) => ({ x: p.x, z: p.z });

/** Beside the spotlight: right if there is room, else left; below for things at the top. */
function placeCard(card: HTMLElement, at: { x: number; y: number; r: number }, width: number, height: number): void {
  const w = Math.min(280, width - 24);
  card.style.width = `${w}px`;
  const h = card.offsetHeight || 190;
  const gap = at.r + 14;
  let left: number;
  let top: number;
  let side: 'left' | 'right' | 'below';
  if (at.y < 110) {
    side = 'below';
    left = at.x - w / 2;
    top = at.y + gap;
  } else if (at.x + gap + w <= width - 12) {
    side = 'right';
    left = at.x + gap;
    top = at.y - h / 2;
  } else {
    side = 'left';
    left = at.x - gap - w;
    top = at.y - h / 2;
  }
  left = Math.max(12, Math.min(width - w - 12, left));
  top = Math.max(8, Math.min(height - h - 8, top));
  card.dataset.side = side;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  // Arrow points at the anchor even after clamping.
  card.style.setProperty('--ax', `${Math.max(16, Math.min(w - 16, at.x - left))}px`);
  card.style.setProperty('--ay', `${Math.max(20, Math.min(h - 20, at.y - top))}px`);
}

function placeBubble(bubble: HTMLElement, at: { x: number; y: number; r: number }, width: number): void {
  const w = Math.min(240, width - 24);
  bubble.style.maxWidth = `${w}px`;
  const bw = bubble.offsetWidth || w;
  const bh = bubble.offsetHeight || 44;
  const above = at.y - at.r - 12 - bh > 8;
  const left = Math.max(12, Math.min(width - bw - 12, at.x - bw / 2));
  bubble.dataset.side = above ? 'above' : 'below';
  bubble.style.left = `${left}px`;
  bubble.style.top = `${above ? at.y - at.r - 12 - bh : at.y + at.r + 12}px`;
  bubble.style.setProperty('--ax', `${Math.max(14, Math.min(bw - 14, at.x - left))}px`);
}

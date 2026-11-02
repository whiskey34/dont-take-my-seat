import { CONFIG } from '../core/config';
import { dist, pushTarget, seatInReach } from '../core/game';
import { seatFront } from '../core/layout';
import type { GameState, Player, PlayerInput, Seat, Vec2 } from '../core/types';
import { NO_INPUT } from '../core/types';

/** Per-bot personality and memory. Bots use their own RNG so they never disturb the game's. */
export interface BotBrain {
  reaction: number; // seconds before reacting to the doors opening
  speed: number; // 0..1 stick strength
  trapChance: number; // chance to go for the priority seat if it is closest
  aggression: number; // pushes per second when blocked
  rng: number;
  targetSeatId: number | null;
  scrambleSeenAt: number | null;
  wander: Vec2;
  wanderUntil: number;
  wantsTrap: boolean | null;
}

export function createBrain(seed: number, level: 'easy' | 'normal' = 'normal'): BotBrain {
  const r = (n: number) => ((Math.sin(seed * 9301 + n * 49297) * 233280) % 1 + 1) % 1;
  const easy = level === 'easy';
  return {
    reaction: (easy ? 0.7 : 0.45) + r(1) * 0.4,
    speed: (easy ? 0.65 : 0.76) + r(2) * 0.12,
    trapChance: easy ? 0.35 : 0.15,
    aggression: (easy ? 0.6 : 1.4) * (0.5 + r(3)),
    rng: Math.floor(r(4) * 1e9) | 1,
    targetSeatId: null,
    scrambleSeenAt: null,
    wander: { x: 0, z: 0 },
    wanderUntil: 0,
    wantsTrap: null,
  };
}

function rand(b: BotBrain): number {
  // xorshift32
  let x = b.rng;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  b.rng = x | 0;
  return (x >>> 0) / 4294967296;
}

export function botThink(s: GameState, me: Player, b: BotBrain, dt: number): PlayerInput {
  if (me.eliminated || me.seatId !== null) return NO_INPUT;

  if (s.phase === 'riding') {
    b.scrambleSeenAt = null;
    b.targetSeatId = null;
    b.wantsTrap = null;
    if (s.time >= b.wanderUntil) {
      b.wander = { x: me.pos.x + (rand(b) - 0.5) * 3, z: (rand(b) - 0.5) * 1.6 };
      b.wanderUntil = s.time + 0.8 + rand(b) * 1.5;
    }
    return steer(me, b.wander, 0.35, maybePush(s, me, b, dt, 0.25));
  }

  if (s.phase !== 'scramble') return NO_INPUT;
  if (b.scrambleSeenAt === null) b.scrambleSeenAt = s.time;
  if (s.time - b.scrambleSeenAt < b.reaction) return NO_INPUT;

  const target = chooseSeat(s, me, b);
  if (!target) return { ...NO_INPUT, action: maybePush(s, me, b, dt, 1) };

  if (seatInReach(s, me)?.id === target.id) return { moveX: 0, moveZ: 0, action: true };

  const front = seatFront(target);
  // Approach from the aisle side so we do not grind along the bench.
  const goal = dist(me.pos, front) > 1.2 ? { x: front.x, z: front.z * 0.6 } : front;
  const blocked = s.players.some(
    (o) => o !== me && !o.eliminated && o.seatId === null && dist(o.pos, front) < dist(me.pos, front) && dist(o.pos, me.pos) < CONFIG.push.range,
  );
  return steer(me, goal, b.speed, blocked && maybePush(s, me, b, dt, 1));
}

function chooseSeat(s: GameState, me: Player, b: BotBrain): Seat | undefined {
  const current = b.targetSeatId === null ? undefined : s.seats[b.targetSeatId];
  if (current && !current.npc && current.playerId === null) return current;

  const open = s.seats.filter((seat) => !seat.npc && seat.playerId === null);
  if (open.length === 0) return undefined;
  if (b.wantsTrap === null) b.wantsTrap = rand(b) < b.trapChance;
  const candidates = b.wantsTrap ? open : open.filter((seat) => !seat.priority);
  const pool = candidates.length > 0 ? candidates : open;
  // Prefer seats we can reach before the others, with a little noise.
  let best: Seat | undefined;
  let bestScore = Infinity;
  for (const seat of pool) {
    const mine = dist(me.pos, seatFront(seat));
    const rival = Math.min(
      Infinity,
      ...s.players.filter((o) => o !== me && !o.eliminated && o.seatId === null).map((o) => dist(o.pos, seatFront(seat))),
    );
    const score = mine + (rival < mine ? 2 : 0) + rand(b) * 0.6;
    if (score < bestScore) {
      best = seat;
      bestScore = score;
    }
  }
  b.targetSeatId = best?.id ?? null;
  return best;
}

function maybePush(s: GameState, me: Player, b: BotBrain, dt: number, scale: number): boolean {
  if (s.time < me.pushReadyAt || !pushTarget(s, me)) return false;
  return rand(b) < b.aggression * scale * dt;
}

function steer(me: Player, goal: Vec2, strength: number, action: boolean): PlayerInput {
  const dx = goal.x - me.pos.x;
  const dz = goal.z - me.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.08) return { moveX: 0, moveZ: 0, action };
  const k = Math.min(1, d / 0.5) * strength;
  return { moveX: (dx / d) * k, moveZ: (dz / d) * k, action };
}

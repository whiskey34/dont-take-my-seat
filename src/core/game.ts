import { CONFIG, STATIONS } from './config';
import { createSeats, POLES, seatFront, seatSitPos } from './layout';
import { nextRandom, pickDistinct } from './rng';
import type { GameEvent, GameState, Phase, Player, PlayerId, PlayerInput, PlayerSetup, Seat, Vec2 } from './types';
import { NO_INPUT } from './types';

const { car, player: P, push: PUSH, phase: PH } = CONFIG;

export function createGame(setups: readonly PlayerSetup[], seed: number): GameState {
  if (setups.length < 2 || setups.length > CONFIG.maxPlayers) {
    throw new Error(`Need 2-${CONFIG.maxPlayers} players, got ${setups.length}`);
  }
  if (new Set(setups.map((s) => s.id)).size !== setups.length) {
    throw new Error('Player ids must be unique');
  }
  const players: Player[] = setups.map((s, i) => ({
    id: s.id,
    name: s.name,
    isBot: s.isBot,
    colorIndex: i,
    pos: { x: 0, z: 0 },
    vel: { x: 0, z: 0 },
    facing: 0,
    seatId: null,
    eliminated: false,
    eliminatedInRound: null,
    stunnedUntil: 0,
    pushReadyAt: 0,
    kickAt: null,
  }));
  const state: GameState = {
    time: 0,
    phase: 'intro',
    phaseEndsAt: PH.intro,
    round: 0,
    station: STATIONS[0],
    players,
    seats: createSeats(),
    freeSeatIds: [],
    trapSeatId: null,
    winnerId: null,
    rngState: seed | 0,
  };
  placeStandingPlayers(state);
  return state;
}

export const alivePlayers = (s: GameState): Player[] => s.players.filter((p) => !p.eliminated);

export function findSeat(s: GameState, id: number | null): Seat | undefined {
  return id === null ? undefined : s.seats[id];
}

/** Free seat the player could sit on right now, or undefined. */
export function seatInReach(s: GameState, p: Player): Seat | undefined {
  if (s.phase !== 'scramble' || p.seatId !== null || p.eliminated) return undefined;
  let best: Seat | undefined;
  let bestD: number = CONFIG.sitRange;
  for (const seat of s.seats) {
    if (seat.npc || seat.playerId !== null) continue;
    const d = dist(p.pos, seatFront(seat));
    if (d <= bestD) {
      best = seat;
      bestD = d;
    }
  }
  return best;
}

/**
 * Advances the game by `dt` seconds. `inputs` maps player id to that
 * player's input for this tick; missing players get no input.
 * Mutates `s` and returns what happened, for sound, effects and UI.
 */
export function step(s: GameState, inputs: ReadonlyMap<PlayerId, PlayerInput>, dt: number): GameEvent[] {
  const events: GameEvent[] = [];
  if (s.phase === 'gameOver') return events;
  s.time += dt;

  if (s.phase === 'riding' || s.phase === 'scramble') {
    for (const p of s.players) {
      if (p.eliminated) continue;
      const input = inputs.get(p.id) ?? NO_INPUT;
      handleAction(s, p, input, events);
      if (p.seatId === null) move(s, p, input, dt);
    }
    resolveCollisions(s);
    handlePriorityKicks(s, events);
  }

  if (s.phase === 'scramble' && allFreeSeatsTaken(s)) s.phaseEndsAt = s.time;
  if (s.time >= s.phaseEndsAt) advancePhase(s, events);
  return events;
}

// ---------------------------------------------------------------- phases

function setPhase(s: GameState, phase: Phase, duration: number, events: GameEvent[]): void {
  s.phase = phase;
  s.phaseEndsAt = s.time + duration;
  events.push({ type: 'phase', phase });
}

function advancePhase(s: GameState, events: GameEvent[]): void {
  switch (s.phase) {
    case 'intro':
      startRound(s);
      setPhase(s, 'riding', PH.riding, events);
      break;
    case 'riding':
      openDoors(s, events);
      setPhase(s, 'scramble', PH.scramble, events);
      break;
    case 'scramble':
      resolveRound(s, events);
      setPhase(s, 'result', PH.result, events);
      break;
    case 'result':
      if (alivePlayers(s).length <= 1) {
        const winner = alivePlayers(s)[0];
        if (winner) {
          s.winnerId = winner.id;
          events.push({ type: 'winner', playerId: winner.id });
        }
        setPhase(s, 'gameOver', Infinity, events);
      } else {
        s.round++;
        startRound(s);
        setPhase(s, 'riding', PH.riding, events);
      }
      break;
    case 'gameOver':
      break;
  }
}

function startRound(s: GameState): void {
  s.station = STATIONS[s.round % STATIONS.length] ?? STATIONS[0];
  for (const seat of s.seats) {
    seat.npc = true;
    seat.playerId = null;
  }
  s.freeSeatIds = [];
  s.trapSeatId = null;
  for (const p of s.players) {
    p.seatId = null;
    p.kickAt = null;
    p.vel = { x: 0, z: 0 };
    p.stunnedUntil = 0;
  }
  placeStandingPlayers(s);
}

/** Standing players start spread along the aisle around the middle door. */
function placeStandingPlayers(s: GameState): void {
  const alive = alivePlayers(s);
  let rng = s.rngState;
  alive.forEach((p, i) => {
    const [r, n] = nextRandom(rng);
    rng = n;
    const x = (i - (alive.length - 1) / 2) * 2.4 + (r - 0.5) * 0.8;
    p.pos = { x, z: i % 2 === 0 ? -0.5 : 0.5 };
    p.facing = 0;
  });
  for (const p of s.players.filter((q) => q.eliminated)) p.pos = { x: 0, z: 0 };
  s.rngState = rng;
}

function openDoors(s: GameState, events: GameEvent[]): void {
  const needed = alivePlayers(s).length - 1;
  const normal = s.seats.filter((seat) => !seat.priority).map((seat) => seat.id);
  const priority = s.seats.filter((seat) => seat.priority).map((seat) => seat.id);
  const [free, r1] = pickDistinct(normal, needed, s.rngState);
  const [trap, r2] = pickDistinct(priority, 1, r1);
  s.rngState = r2;
  s.freeSeatIds = free;
  s.trapSeatId = trap[0] ?? null;
  for (const id of [...free, ...trap]) {
    const seat = s.seats[id];
    if (seat) seat.npc = false;
  }
  events.push({ type: 'doorsOpen', seatIds: [...free, ...trap] });
}

function allFreeSeatsTaken(s: GameState): boolean {
  return s.freeSeatIds.length > 0 && s.freeSeatIds.every((id) => s.seats[id]?.playerId !== null);
}

/** Anyone standing (or still on a priority seat) when the doors close is out. */
function resolveRound(s: GameState, events: GameEvent[]): void {
  const alive = alivePlayers(s);
  const safe = (p: Player) => p.seatId !== null && p.kickAt === null;
  const losers = alive.filter((p) => !safe(p));
  if (losers.length === alive.length) {
    events.push({ type: 'replay' });
    s.round--; // the same station is played again
    return;
  }
  for (const p of losers) {
    p.eliminated = true;
    p.eliminatedInRound = s.round;
    const seat = findSeat(s, p.seatId);
    if (seat) seat.playerId = null;
    p.seatId = null;
    p.kickAt = null;
  }
  if (losers.length > 0) events.push({ type: 'eliminated', playerIds: losers.map((p) => p.id) });
}

// ---------------------------------------------------------------- actions

function handleAction(s: GameState, p: Player, input: PlayerInput, events: GameEvent[]): void {
  if (!input.action || p.seatId !== null || s.time < p.stunnedUntil) return;

  const seat = seatInReach(s, p);
  if (seat) {
    seat.playerId = p.id;
    p.seatId = seat.id;
    p.pos = seatSitPos(seat);
    p.vel = { x: 0, z: 0 };
    p.facing = seat.side > 0 ? Math.PI : 0;
    p.kickAt = seat.priority ? s.time + CONFIG.priorityKickDelay : null;
    events.push({ type: 'sat', playerId: p.id, seatId: seat.id });
    return;
  }

  if (s.time < p.pushReadyAt) return;
  const target = pushTarget(s, p);
  if (!target) return;
  const dx = target.pos.x - p.pos.x;
  const dz = target.pos.z - p.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  target.vel.x += (dx / len) * PUSH.impulse;
  target.vel.z += (dz / len) * PUSH.impulse;
  target.stunnedUntil = s.time + PUSH.stun;
  p.pushReadyAt = s.time + PUSH.cooldown;
  p.facing = Math.atan2(dx, dz);
  events.push({ type: 'pushed', by: p.id, target: target.id });
}

export function pushTarget(s: GameState, p: Player): Player | undefined {
  let best: Player | undefined;
  let bestD: number = PUSH.range;
  for (const o of s.players) {
    if (o === p || o.eliminated || o.seatId !== null) continue;
    const d = dist(p.pos, o.pos);
    if (d <= bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function handlePriorityKicks(s: GameState, events: GameEvent[]): void {
  for (const p of s.players) {
    if (p.kickAt === null || s.time < p.kickAt) continue;
    const seat = findSeat(s, p.seatId);
    p.kickAt = null;
    p.seatId = null;
    if (!seat) continue;
    seat.playerId = null;
    seat.npc = true; // an elderly passenger takes it
    p.pos = seatFront(seat);
    p.stunnedUntil = s.time + CONFIG.priorityKickStun;
    events.push({ type: 'kicked', playerId: p.id, seatId: seat.id });
  }
}

// ---------------------------------------------------------------- movement

/** Sideways sway and forward braking felt by everyone standing. */
export function trainAccel(s: GameState): Vec2 {
  if (s.phase !== 'riding') return { x: 0, z: 0 };
  const braking = s.phaseEndsAt - s.time < PH.braking;
  return {
    x: braking ? CONFIG.brakeAccel : 0,
    z: CONFIG.sway.amp * Math.sin(s.time * Math.PI * 2 * CONFIG.sway.freq),
  };
}

/** Moves one standing player. Exported so a client can predict its own player. */
export function move(s: GameState, p: Player, input: PlayerInput, dt: number): void {
  let mx = Number.isFinite(input.moveX) ? input.moveX : 0;
  let mz = Number.isFinite(input.moveZ) ? input.moveZ : 0;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  if (s.time < p.stunnedUntil) {
    mx = 0;
    mz = 0;
  }
  const k = 1 - Math.exp(-P.responsiveness * dt);
  p.vel.x += (mx * P.speed - p.vel.x) * k;
  p.vel.z += (mz * P.speed - p.vel.z) * k;
  const a = trainAccel(s);
  p.vel.x += a.x * dt;
  p.vel.z += a.z * dt;
  p.pos.x += p.vel.x * dt;
  p.pos.z += p.vel.z * dt;
  if (Math.hypot(mx, mz) > 0.1) p.facing = Math.atan2(mx, mz);
}

function resolveCollisions(s: GameState): void {
  const standing = s.players.filter((p) => !p.eliminated && p.seatId === null);
  for (let i = 0; i < standing.length; i++) {
    for (let j = i + 1; j < standing.length; j++) {
      separate(standing[i] as Player, standing[j] as Player);
    }
  }
  for (const p of standing) constrainToCar(p);
}

/** Keeps a standing player off the poles and inside the aisle. */
export function constrainToCar(p: Player): void {
  for (const pole of POLES) {
    const min = P.radius + car.poleRadius;
    const dx = p.pos.x - pole.x;
    const dz = p.pos.z - pole.z;
    const d = Math.hypot(dx, dz);
    if (d < min) {
      const nx = d > 1e-6 ? dx / d : 1;
      const nz = d > 1e-6 ? dz / d : 0;
      p.pos.x = pole.x + nx * min;
      p.pos.z = pole.z + nz * min;
    }
  }
  const limX = car.halfLength - P.radius;
  const limZ = car.aisleHalfWidth - P.radius;
  if (Math.abs(p.pos.x) > limX) {
    p.pos.x = Math.sign(p.pos.x) * limX;
    p.vel.x = 0;
  }
  if (Math.abs(p.pos.z) > limZ) {
    p.pos.z = Math.sign(p.pos.z) * limZ;
    p.vel.z = 0;
  }
}

function separate(a: Player, b: Player): void {
  const min = P.radius * 2;
  const dx = b.pos.x - a.pos.x;
  const dz = b.pos.z - a.pos.z;
  const d = Math.hypot(dx, dz);
  if (d >= min) return;
  const nx = d > 1e-6 ? dx / d : 1;
  const nz = d > 1e-6 ? dz / d : 0;
  const push = (min - d) / 2;
  a.pos.x -= nx * push;
  a.pos.z -= nz * push;
  b.pos.x += nx * push;
  b.pos.z += nz * push;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

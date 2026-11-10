import { CONFIG } from './config';
import { POLES } from './layout';
import { nextRandom } from './rng';
import { CHALLENGE_KINDS, POWER_UP_KINDS, type GameEvent, type GameState, type Player, type PlayerInput, type Stander, type Vec2 } from './types';

/**
 * Station challenges and power-ups. One random challenge per stop:
 * - suddenBrake: the train jerks once while riding; whoever stands still stumbles.
 * - crowd: standing passengers drift around the aisle and block the way.
 * - oneSideDoors: only one side's doors open; new passengers board there and block it.
 * - kickFight: the action button can kick a seated player off their seat.
 * - puddles: wet patches on the floor; you slide when you run through them.
 * One power-up lies on the floor every stop.
 */
const C = CONFIG.challenge;
const PU = CONFIG.powerUp;
const { car, player: P } = CONFIG;

function rand(s: GameState): number {
  const [r, n] = nextRandom(s.rngState);
  s.rngState = n;
  return r;
}

const between = (s: GameState, a: number, b: number) => a + rand(s) * (b - a);

/** Called when a stop begins (train leaves the previous station). */
export function startChallenge(s: GameState, events: GameEvent[]): void {
  s.standers = [];
  s.powerUps = [];
  s.brakeAt = null;
  s.brakeUntil = 0;
  s.doorSide = 0;
  s.puddles = [];
  const kind = CHALLENGE_KINDS[Math.floor(rand(s) * CHALLENGE_KINDS.length)] ?? 'suddenBrake';
  s.challenge = kind;
  if (kind === 'suddenBrake') s.brakeAt = s.time + between(s, C.brakeWindow[0], C.brakeWindow[1]);
  if (kind === 'crowd') {
    for (let i = 0; i < C.crowdCount; i++) {
      // Spread along the car so nobody starts inside a passenger.
      const x = -car.halfLength + 2 + ((i + 0.5) / C.crowdCount) * (car.halfLength * 2 - 4) + between(s, -0.8, 0.8);
      addStander(s, { x, z: between(s, -0.9, 0.9) });
    }
  }
  if (kind === 'oneSideDoors') s.doorSide = rand(s) < 0.5 ? -1 : 1;
  if (kind === 'puddles') {
    for (let i = 0; i < C.puddleCount; i++) {
      // One puddle in each part of the car, so every route crosses some wet floor.
      const span = (car.halfLength * 2 - 4) / C.puddleCount;
      const x = -car.halfLength + 2 + span * (i + 0.5) + between(s, -span * 0.3, span * 0.3);
      s.puddles.push({ x, z: between(s, -0.7, 0.7), r: between(s, C.puddleRadius[0], C.puddleRadius[1]) });
    }
  }
  spawnPowerUp(s);
  events.push({ type: 'challenge', kind });
}

/** Called when the doors open: passengers board through the open side. */
export function boardPassengers(s: GameState): void {
  if (s.challenge !== 'oneSideDoors' || s.doorSide === 0) return;
  const doors = [...car.doorsX];
  for (let i = 0; i < C.boardingCount; i++) {
    const x = doors[i % doors.length]! + between(s, -0.3, 0.3);
    const st = addStander(s, { x, z: s.doorSide * (car.aisleHalfWidth - 0.2) });
    // Walk in and stop in the middle of the aisle, right where players run.
    st.target = { x: x + between(s, -0.5, 0.5), z: s.doorSide * between(s, 0, 0.35) };
    st.moveAt = Infinity;
  }
}

/** Runs every tick of riding and scramble, before players move. */
export function updateChallenge(s: GameState, inputs: ReadonlyMap<string, PlayerInput>, dt: number, events: GameEvent[]): void {
  if (s.brakeAt !== null && s.time >= s.brakeAt) {
    s.brakeAt = null;
    s.brakeUntil = s.time + C.brakeDuration;
    events.push({ type: 'suddenBrake' });
    for (const p of s.players) {
      if (p.eliminated || p.seatId !== null || s.time < p.shieldUntil) continue;
      const input = inputs.get(p.id);
      const moving = !!input && Math.hypot(input.moveX, input.moveZ) > 0.15;
      if (!moving) p.stunnedUntil = Math.max(p.stunnedUntil, s.time + C.brakeStun);
    }
  }
  for (const st of s.standers) moveStander(s, st, dt);
}

/** Pick-ups, after players move. */
export function collectPowerUps(s: GameState, events: GameEvent[]): void {
  for (const p of s.players) {
    if (p.eliminated || p.seatId !== null) continue;
    const i = s.powerUps.findIndex((u) => Math.hypot(u.pos.x - p.pos.x, u.pos.z - p.pos.z) <= PU.pickRange);
    if (i < 0) continue;
    const [u] = s.powerUps.splice(i, 1);
    if (!u) continue;
    if (u.kind === 'earphones') p.shieldUntil = s.time + PU.shieldTime;
    else p.sleeping = true;
    events.push({ type: 'powerUp', playerId: p.id, kind: u.kind });
  }
}

/** Pushes a standing player out of every standing passenger. */
export function keepOutOfStanders(s: GameState, p: Player): void {
  const min = P.radius + C.standerRadius;
  for (const st of s.standers) {
    const dx = p.pos.x - st.pos.x;
    const dz = p.pos.z - st.pos.z;
    const d = Math.hypot(dx, dz);
    if (d >= min) continue;
    // Slide sideways rather than straight back, so passengers can be walked around.
    const nx = d > 1e-6 ? dx / d : 0;
    const nz = d > 1e-6 ? dz / d : 1;
    p.pos.x = st.pos.x + nx * min;
    p.pos.z = st.pos.z + nz * min;
    const vn = p.vel.x * nx + p.vel.z * nz;
    if (vn < 0) {
      p.vel.x -= vn * nx;
      p.vel.z -= vn * nz;
    }
  }
}

export const isShielded = (s: GameState, p: Player): boolean => s.time < p.shieldUntil;

// ------------------------------------------------------------------ helpers

function addStander(s: GameState, pos: Vec2): Stander {
  const st: Stander = { id: s.nextId++, pos: clampAisle(pos), target: clampAisle(pos), moveAt: s.time + between(s, 0.5, 2) };
  s.standers.push(st);
  return st;
}

function moveStander(s: GameState, st: Stander, dt: number): void {
  if (s.time >= st.moveAt) {
    st.target = clampAisle({ x: st.pos.x + between(s, -1.6, 1.6), z: between(s, -0.9, 0.9) });
    st.moveAt = s.time + between(s, 2, 3.5);
  }
  const dx = st.target.x - st.pos.x;
  const dz = st.target.z - st.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.02) return;
  const stepLen = Math.min(d, C.standerSpeed * dt);
  st.pos.x += (dx / d) * stepLen;
  st.pos.z += (dz / d) * stepLen;
}

function clampAisle(v: Vec2): Vec2 {
  const limX = car.halfLength - C.standerRadius - 0.2;
  const limZ = car.aisleHalfWidth - C.standerRadius;
  let x = Math.max(-limX, Math.min(limX, v.x));
  const z = Math.max(-limZ, Math.min(limZ, v.z));
  // Keep clear of poles.
  for (const pole of POLES) if (Math.abs(x - pole.x) < 0.45 && Math.abs(z - pole.z) < 0.45) x = pole.x + (x >= pole.x ? 0.45 : -0.45);
  return { x, z };
}

function spawnPowerUp(s: GameState): void {
  const kind = POWER_UP_KINDS[Math.floor(rand(s) * POWER_UP_KINDS.length)] ?? 'earphones';
  let pos: Vec2 = { x: 0, z: 0 };
  for (let tries = 0; tries < 10; tries++) {
    pos = { x: between(s, -9.5, 9.5), z: between(s, -0.9, 0.9) };
    const nearPole = POLES.some((pl) => Math.hypot(pl.x - pos.x, pl.z - pos.z) < 0.7);
    const nearPlayer = s.players.some((p) => !p.eliminated && Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z) < 2);
    if (!nearPole && !nearPlayer) break;
  }
  s.powerUps.push({ id: s.nextId++, kind, pos });
}

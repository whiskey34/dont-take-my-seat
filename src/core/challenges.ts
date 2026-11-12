import { CONFIG } from './config';
import { POLES, seatFront } from './layout';
import { nextRandom } from './rng';
import { CHALLENGE_KINDS, POWER_UP_KINDS, type GameEvent, type GameState, type Player, type PlayerInput, type Seat, type Stander, type Vec2 } from './types';

/**
 * Station challenges and power-ups. One random challenge per stop:
 * - suddenBrake: the train jerks once while riding; whoever stands still stumbles.
 * - crowd: standing passengers drift around the aisle and block the way.
 * - oneSideDoors: only one side's doors open; new passengers board there and block it.
 * - kickFight: the action button can kick a seated player off their seat.
 * - puddles: wet patches on the floor; you slide when you run through them.
 * - rushHour (special event, at most twice a game, never at the first or last
 *   stop): the aisle is packed with standing passengers; you squeeze through slowly.
 * One to three power-ups lie on the floor every stop (the MBG tray is a bad one).
 * At every stop but the last, one to three standing passengers are seat hunters:
 * when the doors open they race the players for a seat (see `updateHunters`).
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
  const rush = s.round >= 1 && s.round + 2 < s.route.length && s.rushHours < C.rushMax && rand(s) < C.rushChance;
  const kind = rush ? 'rushHour' : (CHALLENGE_KINDS[Math.floor(rand(s) * CHALLENGE_KINDS.length)] ?? 'suddenBrake');
  s.challenge = kind;
  if (rush) {
    s.rushHours++;
    for (let i = 0; i < C.rushCount; i++) {
      const x = -car.halfLength + 1.6 + ((i + 0.5) / C.rushCount) * (car.halfLength * 2 - 3.2) + between(s, -0.4, 0.4);
      addStander(s, { x, z: between(s, -C.rushLane, C.rushLane) });
    }
  }
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
  const count = PU.perStop[0] + Math.floor(rand(s) * (PU.perStop[1] - PU.perStop[0] + 1));
  for (let i = 0; i < count; i++) spawnPowerUp(s);
  spawnHunters(s, rush);
  events.push({ type: 'challenge', kind });
}

/** Called when the doors open: hunters get ready, passengers board through the open side. */
export function boardPassengers(s: GameState): void {
  for (const st of s.standers) if (st.hunt) st.hunt.startAt = s.time + between(s, C.hunterReaction[0], C.hunterReaction[1]);
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
  for (const st of s.standers) if (!st.hunt) moveStander(s, st, dt);
  updateHunters(s, dt, events);
}

// ------------------------------------------------------------ seat hunters

/** Extra ordinary seats to open for this stop's hunters (elders take priority seats instead). */
export function hunterSeats(s: GameState): number {
  return s.standers.filter((st) => st.hunt && !st.hunt.elder).length;
}

function spawnHunters(s: GameState, rush: boolean): void {
  if (s.round + 2 >= s.route.length) return; // the last stop is for players only
  const [lo, hi] = rush ? C.huntersRush : C.hunters;
  const count = lo + Math.floor(rand(s) * (hi - lo + 1));
  let elder = rand(s) < C.elderChance;
  for (let i = 0; i < count; i++) {
    let pos: Vec2 = { x: 0, z: 0 };
    for (let tries = 0; tries < 12; tries++) {
      pos = { x: between(s, -9, 9), z: between(s, -0.6, 0.6) };
      const clear = (q: Vec2, r: number) => Math.hypot(q.x - pos.x, q.z - pos.z) >= r;
      if (s.players.every((p) => p.eliminated || clear(p.pos, 1.3)) && s.standers.every((o) => clear(o.pos, 0.9))) break;
    }
    const st = addStander(s, pos);
    st.moveAt = Infinity; // waits for the doors
    st.hunt = { elder, startAt: Infinity, stunUntil: 0, vel: { x: 0, z: 0 } };
    elder = false;
  }
}

/** The open seat this hunter runs for: the nearest one it wants (priority seats for elders only). */
function huntTarget(s: GameState, st: Stander): Seat | undefined {
  const ids = s.trapSeatId === null ? s.freeSeatIds : [...s.freeSeatIds, s.trapSeatId];
  let best: Seat | undefined;
  let bestD = Infinity;
  for (const id of ids) {
    const seat = s.seats[id];
    if (!seat || seat.npc || seat.playerId !== null || seat.priority !== !!st.hunt?.elder) continue;
    const front = seatFront(seat);
    const d = Math.hypot(front.x - st.pos.x, front.z - st.pos.z);
    if (d < bestD) {
      best = seat;
      bestD = d;
    }
  }
  return best;
}

/** Hunters run to the nearest open seat they want and sit down; a push dazes them. */
function updateHunters(s: GameState, dt: number, events: GameEvent[]): void {
  const sat: number[] = [];
  for (const st of s.standers) {
    const h = st.hunt;
    if (!h) continue;
    if (h.vel.x !== 0 || h.vel.z !== 0) {
      st.pos = clampAisle({ x: st.pos.x + h.vel.x * dt, z: st.pos.z + h.vel.z * dt });
      const keep = Math.max(0, 1 - 6 * dt);
      h.vel = Math.hypot(h.vel.x, h.vel.z) * keep < 0.05 ? { x: 0, z: 0 } : { x: h.vel.x * keep, z: h.vel.z * keep };
    }
    if (s.phase !== 'scramble' || s.time < h.startAt || s.time < h.stunUntil) continue;
    const seat = huntTarget(s, st);
    if (!seat) continue;
    const front = seatFront(seat);
    const dx = front.x - st.pos.x;
    const dz = front.z - st.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= CONFIG.sitRange * 0.8) {
      seat.npc = true;
      sat.push(st.id);
      events.push({ type: 'npcSat', seatId: seat.id });
      continue;
    }
    const speed = (h.elder ? C.elderSpeed : C.hunterSpeed) * (s.challenge === 'rushHour' ? 0.65 : 1);
    const len = Math.min(d, speed * dt);
    // Seat fronts are just outside the aisle the standers keep to; step there directly.
    st.pos = { x: st.pos.x + (dx / d) * len, z: st.pos.z + (dz / d) * len };
    st.target = { ...st.pos };
  }
  if (sat.length > 0) s.standers = s.standers.filter((st) => !sat.includes(st.id));
}

/** A hunter close enough to push, and how far away it is. */
export function hunterInReach(s: GameState, p: Player): { st: Stander; d: number } | undefined {
  let best: { st: Stander; d: number } | undefined;
  for (const st of s.standers) {
    if (!st.hunt) continue;
    const d = Math.hypot(st.pos.x - p.pos.x, st.pos.z - p.pos.z);
    if (d <= CONFIG.push.range && (!best || d < best.d)) best = { st, d };
  }
  return best;
}

/** A push knocks a hunter back and dazes it for a moment. */
export function pushHunter(s: GameState, st: Stander, dir: Vec2): void {
  if (!st.hunt) return;
  const len = Math.hypot(dir.x, dir.z) || 1;
  st.hunt.vel = { x: (dir.x / len) * C.hunterKnock, z: (dir.z / len) * C.hunterKnock };
  st.hunt.stunUntil = s.time + C.hunterStun;
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
    else if (u.kind === 'coffee') p.boostUntil = s.time + PU.boostTime;
    else if (u.kind === 'mbg') {
      // Food poisoning: green and slow. It also spoils a coffee boost.
      p.sickUntil = s.time + PU.sickTime;
      p.boostUntil = 0;
    }
    else p.sleeping = true;
    events.push({ type: 'powerUp', playerId: p.id, kind: u.kind });
  }
}

/** Pushes a standing player out of every standing passenger. */
export function keepOutOfStanders(s: GameState, p: Player): void {
  // Rush hour: bodies give a little, so you can squeeze between them (slowly).
  const rush = s.challenge === 'rushHour';
  const min = P.radius + C.standerRadius - (rush ? C.rushSqueeze : 0);
  let squeezed = false;
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
    squeezed = true;
  }
  if (rush && squeezed) {
    p.vel.x *= C.rushDrag;
    p.vel.z *= C.rushDrag;
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
    const rush = s.challenge === 'rushHour';
    const lane = rush ? C.rushLane : 0.9;
    st.target = clampAisle({ x: st.pos.x + between(s, rush ? -0.6 : -1.6, rush ? 0.6 : 1.6), z: between(s, -lane, lane) });
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
    const nearItem = s.powerUps.some((u) => Math.hypot(u.pos.x - pos.x, u.pos.z - pos.z) < 2.5);
    if (!nearPole && !nearPlayer && !nearItem) break;
  }
  s.powerUps.push({ id: s.nextId++, kind, pos });
}

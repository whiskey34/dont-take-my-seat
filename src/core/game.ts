import { boardPassengers, collectPowerUps, isShielded, keepOutOfStanders, startChallenge, updateChallenge } from './challenges';
import { BOGOR_LINE, CONFIG, NAMBO_BRANCH, ROUTE_LENGTH } from './config';
import { createSeats, POLES, seatFront, seatSitPos } from './layout';
import { nextRandom, pickDistinct } from './rng';
import type { GameEvent, GameState, Phase, Player, PlayerId, PlayerInput, PlayerSetup, Seat, Vec2 } from './types';
import { NO_INPUT } from './types';

const { car, player: P, push: PUSH, phase: PH } = CONFIG;

/** Where the priority seats normally are (the car corners). */
const BASE_PRIORITY: readonly boolean[] = createSeats().map((seat) => seat.priority);

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
    shieldUntil: 0,
    sleeping: false,
    boostUntil: 0,
    slipUntil: 0,
    npcStrikes: 0,
    sickUntil: 0,
    score: Math.max(0, Math.floor(s.score ?? 0)),
  }));
  const [route, rngAfterRoute] = pickRoute(seed | 0);
  const state: GameState = {
    time: 0,
    phase: 'intro',
    phaseEndsAt: PH.intro,
    round: 0,
    station: route[0]!,
    route,
    players,
    seats: createSeats(),
    freeSeatIds: [],
    trapSeatId: null,
    seatMove: null,
    rushHours: 0,
    winnerId: null,
    rngState: rngAfterRoute,
    challenge: null,
    brakeAt: null,
    brakeUntil: 0,
    doorSide: 0,
    standers: [],
    powerUps: [],
    puddles: [],
    nextId: 1,
  };
  placeStandingPlayers(state);
  return state;
}

/**
 * A random stretch of the line: toward Jakarta Kota or toward Bogor, and now
 * and then starting from Nambo (the Cibinong branch) through Citayam.
 */
export function pickRoute(rng: number): [string[], number] {
  const [a, r1] = nextRandom(rng);
  const [b, r2] = nextRandom(r1);
  const [c, r3] = nextRandom(r2);
  const citayam = BOGOR_LINE.indexOf('Citayam');
  let line: string[];
  if (c < 0.2) {
    // Nambo → Cibinong → Citayam → … toward Jakarta Kota.
    line = [...NAMBO_BRANCH, ...BOGOR_LINE.slice(citayam)];
    return [line.slice(0, ROUTE_LENGTH), r3];
  }
  line = b < 0.5 ? [...BOGOR_LINE] : [...BOGOR_LINE].reverse();
  const start = Math.floor(a * (line.length - ROUTE_LENGTH + 1));
  return [line.slice(start, start + ROUTE_LENGTH), r3];
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
    updateChallenge(s, inputs, dt, events);
    for (const p of s.players) {
      if (p.eliminated) continue;
      const input = inputs.get(p.id) ?? NO_INPUT;
      handleAction(s, p, input, events);
      if (p.seatId === null && move(s, p, input, dt)) events.push({ type: 'slipped', playerId: p.id });
    }
    resolveCollisions(s);
    collectPowerUps(s, events);
    updateSeatMove(s, events);
    handlePriorityKicks(s, events);
  }

  // In a kick fight seats can change hands, so the scramble always runs its full time.
  if (s.phase === 'scramble' && s.challenge !== 'kickFight' && allFreeSeatsTaken(s)) s.phaseEndsAt = s.time;
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
      startRound(s, events);
      setPhase(s, 'riding', PH.riding, events);
      break;
    case 'riding':
      openDoors(s, events);
      setPhase(s, 'scramble', PH.scramble + extraScrambleTime(s), events);
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
          addPoints(winner, CONFIG.points.win, 'win', events);
          events.push({ type: 'winner', playerId: winner.id });
        }
        setPhase(s, 'gameOver', Infinity, events);
      } else {
        s.round++;
        startRound(s, events);
        setPhase(s, 'riding', PH.riding, events);
      }
      break;
    case 'gameOver':
      break;
  }
}

function startRound(s: GameState, events: GameEvent[]): void {
  // route[0] is where the journey starts (shown during the intro); stops follow.
  s.station = s.route[(s.round + 1) % s.route.length] ?? s.station;
  for (const seat of s.seats) {
    seat.npc = true;
    seat.playerId = null;
  }
  s.freeSeatIds = [];
  s.trapSeatId = null;
  s.seatMove = null;
  // Priority seats are back in the corners at every stop.
  s.seats.forEach((seat, i) => (seat.priority = BASE_PRIORITY[i] ?? seat.priority));
  for (const p of s.players) {
    p.seatId = null;
    p.kickAt = null;
    p.vel = { x: 0, z: 0 };
    p.stunnedUntil = 0;
    p.shieldUntil = 0;
    p.boostUntil = 0;
    p.slipUntil = 0;
    p.sickUntil = 0;
  }
  placeStandingPlayers(s);
  startChallenge(s, events);
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

/** True at the last station of this game's journey (a single seat). */
export function isFinalStop(s: GameState): boolean {
  return s.round + 2 >= s.route.length;
}

/** How many ordinary seats open at this stop (see CONFIG.seats). */
export function seatsThisStop(s: GameState): number {
  const alive = alivePlayers(s).length;
  if (isFinalStop(s)) return 1;
  const stop = s.round + 1;
  const S = CONFIG.seats;
  if (stop <= S.earlyUntilStop) return alive + S.earlyExtra;
  const short = stop < S.tighterFromStop ? 1 : 2;
  return Math.max(1, alive - short);
}

function openDoors(s: GameState, events: GameEvent[]): void {
  const needed = seatsThisStop(s);
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
  boardPassengers(s);
  scheduleSeatMove(s);
  events.push({ type: 'doorsOpen', seatIds: [...free, ...trap] });
}

/** Special events give players more time to find a seat. */
function extraScrambleTime(s: GameState): number {
  const C = CONFIG.challenge;
  return (s.challenge === 'rushHour' ? C.rushExtraTime : 0) + (s.seatMove ? C.seatMoveExtraTime : 0);
}

/**
 * Mini event "the priority seat moves": now and then, a few seconds into the
 * scramble, one or two of the open seats blink red and become priority seats,
 * while the corner priority seat that was open becomes an ordinary one.
 */
function scheduleSeatMove(s: GameState): void {
  const C = CONFIG.challenge;
  if (s.round < 1 || isFinalStop(s) || s.trapSeatId === null || s.freeSeatIds.length < 2) return;
  const [r, r1] = nextRandom(s.rngState);
  s.rngState = r1;
  if (r >= C.seatMoveChance) return;
  // Two seats only when there are still enough ordinary seats for everyone.
  const count = s.freeSeatIds.length - 1 >= alivePlayers(s).length ? 2 : 1;
  const [ids, r2] = pickDistinct(s.freeSeatIds, count, s.rngState);
  const [w, r3] = nextRandom(r2);
  s.rngState = r3;
  const at = s.time + C.seatMoveAfter[0] + w * (C.seatMoveAfter[1] - C.seatMoveAfter[0]);
  s.seatMove = { seatIds: ids, at, warned: false, done: false };
}

function updateSeatMove(s: GameState, events: GameEvent[]): void {
  const m = s.seatMove;
  if (!m || m.done || s.phase !== 'scramble') return;
  if (!m.warned && s.time >= m.at - CONFIG.challenge.seatMoveWarn) {
    m.warned = true;
    events.push({ type: 'seatMoveWarn', seatIds: [...m.seatIds] });
  }
  if (s.time < m.at) return;
  m.done = true;
  // The open corner priority seat turns into an ordinary seat.
  const trap = s.trapSeatId === null ? undefined : s.seats[s.trapSeatId];
  if (trap) {
    trap.priority = false;
    const sitter = s.players.find((q) => q.seatId === trap.id);
    if (sitter) sitter.kickAt = null;
  }
  for (const id of m.seatIds) {
    const seat = s.seats[id];
    if (!seat) continue;
    seat.priority = true;
    const p = s.players.find((q) => q.seatId === id);
    if (!p) continue;
    if (p.sleeping) {
      p.sleeping = false;
      events.push({ type: 'slept', playerId: p.id, seatId: id });
    } else p.kickAt = s.time + CONFIG.priorityKickDelay + CONFIG.challenge.seatMoveGrace;
  }
  s.freeSeatIds = [...s.freeSeatIds.filter((id) => !m.seatIds.includes(id)), ...(trap ? [trap.id] : [])];
  s.trapSeatId = m.seatIds[0] ?? null;
  events.push({ type: 'seatMoved', seatIds: [...m.seatIds] });
}

/** Nothing left to decide: every open seat is taken, or every player sits. */
function allFreeSeatsTaken(s: GameState): boolean {
  if (s.freeSeatIds.length === 0) return false;
  const full = s.freeSeatIds.every((id) => s.seats[id]?.playerId !== null);
  const everyoneSits = alivePlayers(s).every((p) => p.seatId !== null && p.kickAt === null);
  return full || everyoneSits;
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
  for (const p of alive) if (!p.eliminated) addPoints(p, CONFIG.points.round, 'round', events);
}

function addPoints(p: Player, amount: number, reason: 'round' | 'win' | 'kick' | 'penalty', events: GameEvent[]): void {
  p.score += amount;
  events.push({ type: 'points', playerId: p.id, amount, reason });
}

// ---------------------------------------------------------------- actions

function handleAction(s: GameState, p: Player, input: PlayerInput, events: GameEvent[]): void {
  if (!input.action || p.seatId !== null || s.time < p.stunnedUntil) return;

  const seat = seatInReach(s, p);
  // Kick fight: standing right in front of someone seated kicks them, even
  // when an empty seat is also within reach (the closer one wins).
  if (seat && s.time >= p.pushReadyAt && kickBeatsSitting(s, p, seat)) return kickOffSeat(s, p, seatKickTarget(s, p)!, events);
  if (seat) {
    seat.playerId = p.id;
    p.seatId = seat.id;
    p.pos = seatSitPos(seat);
    p.vel = { x: 0, z: 0 };
    p.facing = seat.side > 0 ? Math.PI : 0;
    p.kickAt = seat.priority ? s.time + CONFIG.priorityKickDelay : null;
    events.push({ type: 'sat', playerId: p.id, seatId: seat.id });
    if (seat.priority && p.sleeping) {
      // Pretending to sleep: nobody asks you to stand up.
      p.sleeping = false;
      p.kickAt = null;
      events.push({ type: 'slept', playerId: p.id, seatId: seat.id });
    }
    return;
  }

  if (s.time < p.pushReadyAt) return;
  const victim = seatKickTarget(s, p);
  if (victim) return kickOffSeat(s, p, victim, events);
  const target = pushTarget(s, p);
  // Kicking a seated passenger: only when nobody standing is closer to push.
  const npcSeat = npcKickSeat(s, p);
  if (npcSeat && (!target || dist(p.pos, seatFront(npcSeat)) < dist(p.pos, target.pos))) return kickNpc(s, p, npcSeat, events);
  if (!target) return;
  const dx = target.pos.x - p.pos.x;
  const dz = target.pos.z - p.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  p.pushReadyAt = s.time + PUSH.cooldown;
  p.facing = Math.atan2(dx, dz);
  if (isShielded(s, target)) {
    // Earphones in: the push does nothing.
    events.push({ type: 'shielded', playerId: target.id });
    return;
  }
  target.vel.x += (dx / len) * PUSH.impulse;
  target.vel.z += (dz / len) * PUSH.impulse;
  target.stunnedUntil = s.time + PUSH.stun;
  events.push({ type: 'pushed', by: p.id, target: target.id });
}


/** A seated passenger (not on a priority seat) right in front of us, during the scramble. */
export function npcKickSeat(s: GameState, p: Player): Seat | undefined {
  if (s.phase !== 'scramble' || p.seatId !== null || p.eliminated) return undefined;
  let best: Seat | undefined;
  let bestD: number = CONFIG.challenge.npcKickRange;
  for (const seat of s.seats) {
    if (!seat.npc || seat.priority || seat.playerId !== null) continue;
    const d = dist(p.pos, seatFront(seat));
    if (d <= bestD) {
      best = seat;
      bestD = d;
    }
  }
  return best;
}

/**
 * Kicking a passenger off their seat works, but the staff notice: the first
 * time costs points, the second time an officer takes you off the train
 * (out for the rest of this game).
 */
function kickNpc(s: GameState, p: Player, seat: Seat, events: GameEvent[]): void {
  p.pushReadyAt = s.time + CONFIG.challenge.kickCooldown;
  p.npcStrikes++;
  events.push({ type: 'npcKick', playerId: p.id, seatId: seat.id, strike: p.npcStrikes });
  if (p.npcStrikes >= 2) {
    // Taken away by an officer; the passenger keeps the seat.
    p.eliminated = true;
    p.eliminatedInRound = s.round;
    p.kickAt = null;
    events.push({ type: 'escorted', playerId: p.id, seatId: seat.id });
    return;
  }
  seat.npc = false;
  const lost = Math.min(p.score, CONFIG.challenge.npcKickPenalty);
  p.score -= lost;
  if (lost > 0) events.push({ type: 'points', playerId: p.id, amount: -lost, reason: 'penalty' });
  // You do get the seat.
  seat.playerId = p.id;
  p.seatId = seat.id;
  p.pos = seatSitPos(seat);
  p.vel = { x: 0, z: 0 };
  p.facing = seat.side > 0 ? Math.PI : 0;
  p.kickAt = null;
  events.push({ type: 'sat', playerId: p.id, seatId: seat.id });
}

/** True when a seated player is closer in front of us than the free seat we could take. */
export function kickBeatsSitting(s: GameState, p: Player, freeSeat: Seat): boolean {
  const victim = seatKickTarget(s, p);
  const theirs = victim ? findSeat(s, victim.seatId) : undefined;
  return !!theirs && dist(p.pos, seatFront(theirs)) < dist(p.pos, seatFront(freeSeat));
}

/** Kick fight: a seated player right in front of us that we could kick off their seat. */
export function seatKickTarget(s: GameState, p: Player): Player | undefined {
  if (s.challenge !== 'kickFight' || s.phase !== 'scramble' || p.seatId !== null || p.eliminated) return undefined;
  let best: Player | undefined;
  let bestD: number = CONFIG.challenge.kickRange;
  for (const o of s.players) {
    const seat = o === p || o.eliminated ? undefined : findSeat(s, o.seatId);
    if (!seat) continue;
    const d = dist(p.pos, seatFront(seat));
    if (d <= bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function kickOffSeat(s: GameState, p: Player, target: Player, events: GameEvent[]): void {
  const seat = findSeat(s, target.seatId);
  if (!seat) return;
  p.pushReadyAt = s.time + CONFIG.challenge.kickCooldown;
  p.facing = seat.side > 0 ? 0 : Math.PI;
  if (isShielded(s, target)) {
    events.push({ type: 'shielded', playerId: target.id });
    return;
  }
  seat.playerId = null;
  target.seatId = null;
  target.kickAt = null;
  // Lands in the aisle beside the seat, a little dazed.
  const front = seatFront(seat);
  const side = target.pos.x >= p.pos.x ? 1 : -1;
  target.pos = { x: front.x + side * 0.7, z: front.z * 0.7 };
  target.vel = { x: side * 3, z: -seat.side * 1.5 };
  target.stunnedUntil = s.time + CONFIG.challenge.kickStun;
  events.push({ type: 'seatKick', by: p.id, target: target.id, seatId: seat.id });
  addPoints(p, CONFIG.points.kick, 'kick', events);
}

/** True if the point is inside a puddle (wet floor challenge). */
export function onPuddle(s: GameState, pos: Vec2): boolean {
  return s.puddles.some((d) => Math.hypot(pos.x - d.x, pos.z - d.z) < d.r);
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
  const jolt = s.time < s.brakeUntil ? CONFIG.challenge.brakeAccel : 0;
  return {
    x: (braking ? CONFIG.brakeAccel : 0) + jolt,
    z: CONFIG.sway.amp * Math.sin(s.time * Math.PI * 2 * CONFIG.sway.freq),
  };
}

/** Moves one standing player. Exported so a client can predict its own player. */
/** Moves one player for one tick. Returns true if they just slipped on a puddle. */
export function move(s: GameState, p: Player, input: PlayerInput, dt: number): boolean {
  let mx = Number.isFinite(input.moveX) ? input.moveX : 0;
  let mz = Number.isFinite(input.moveZ) ? input.moveZ : 0;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const slipped = slip(s, p);
  if (s.time < p.stunnedUntil) {
    mx = 0;
    mz = 0;
  }
  // Sliding after a slip keeps going a long way; otherwise normal grip.
  const grip: number = s.time < p.slipUntil ? CONFIG.challenge.slipGrip : P.responsiveness;
  const k = 1 - Math.exp(-grip * dt);
  const boost = s.time < p.boostUntil ? CONFIG.powerUp.boostSpeed : 1;
  const sick = s.time < p.sickUntil ? CONFIG.powerUp.sickSpeed : 1;
  const speed = P.speed * boost * sick;
  p.vel.x += (mx * speed - p.vel.x) * k;
  p.vel.z += (mz * speed - p.vel.z) * k;
  const a = trainAccel(s);
  p.vel.x += a.x * dt;
  p.vel.z += a.z * dt;
  p.pos.x += p.vel.x * dt;
  p.pos.z += p.vel.z * dt;
  if (Math.hypot(mx, mz) > 0.1) p.facing = Math.atan2(mx, mz);
  return slipped;
}

/**
 * Wet floor: running onto a puddle makes you slip. You shoot off in the
 * direction you were going and cannot steer until the slide is over.
 */
function slip(s: GameState, p: Player): boolean {
  const C = CONFIG.challenge;
  if (s.puddles.length === 0 || s.time < p.stunnedUntil + C.slipAgainAfter || !onPuddle(s, p.pos)) return false;
  const v = Math.hypot(p.vel.x, p.vel.z);
  if (v < C.slipMinSpeed) return false;
  p.vel = { x: (p.vel.x / v) * C.slipSpeed, z: (p.vel.z / v) * C.slipSpeed };
  p.slipUntil = s.time + C.slipTime;
  p.stunnedUntil = Math.max(p.stunnedUntil, p.slipUntil);
  p.facing = Math.atan2(p.vel.x, p.vel.z);
  return true;
}

function resolveCollisions(s: GameState): void {
  const standing = s.players.filter((p) => !p.eliminated && p.seatId === null);
  for (let i = 0; i < standing.length; i++) {
    for (let j = i + 1; j < standing.length; j++) {
      separate(standing[i] as Player, standing[j] as Player);
    }
  }
  for (const p of standing) {
    keepOutOfStanders(s, p);
    constrainToCar(p);
  }
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

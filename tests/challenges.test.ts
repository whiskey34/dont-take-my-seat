import { describe, expect, it } from 'vitest';
import { botThink, createBrain } from '../src/ai/bot';
import { CONFIG } from '../src/core/config';
import { alivePlayers, createGame, step } from '../src/core/game';
import { seatFront, seatSitPos } from '../src/core/layout';
import type { ChallengeKind, GameEvent, GameState, PlayerInput, PlayerSetup } from '../src/core/types';

const DT = 1 / CONFIG.tickRate;
const four: PlayerSetup[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, isBot: true }));
const press: PlayerInput = { moveX: 0, moveZ: 0, action: true };

function runUntil(s: GameState, done: (s: GameState) => boolean, inputs = new Map<string, PlayerInput>()): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < 60 * 60 && !done(s); i++) all.push(...step(s, inputs, DT));
  return all;
}

/** A game whose first stop has the given challenge (found by trying seeds). */
function gameWith(kind: ChallengeKind): GameState {
  for (let seed = 1; seed < 500; seed++) {
    const s = createGame(four, seed);
    runUntil(s, (x) => x.phase === 'riding');
    if (s.challenge === kind) return s;
  }
  throw new Error(`no seed gives ${kind}`);
}

describe('station challenges', () => {
  it('picks one challenge per stop and announces it, with every kind showing up', () => {
    const seen = new Set<ChallengeKind>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = createGame(four, seed);
      const ev = runUntil(s, (x) => x.phase === 'riding');
      const announced = ev.filter((e) => e.type === 'challenge');
      expect(announced).toHaveLength(1);
      expect(s.challenge).not.toBeNull();
      seen.add(s.challenge!);
    }
    expect([...seen].sort()).toEqual(['crowd', 'kickFight', 'oneSideDoors', 'puddles', 'suddenBrake']);
  });

  it('sudden brake throws forward and trips whoever stands still', () => {
    const s = gameWith('suddenBrake');
    const moving = new Map([['a', { moveX: 0, moveZ: 1, action: false }]]);
    const ev = runUntil(s, (x) => x.brakeAt === null && x.brakeUntil > 0, moving);
    expect(ev).toContainEqual({ type: 'suddenBrake' });
    const [a, b] = s.players;
    expect(s.time < b!.stunnedUntil).toBe(true); // stood still
    expect(s.time < a!.stunnedUntil).toBe(false); // kept moving
    const x0 = b!.pos.x;
    for (let i = 0; i < 20; i++) step(s, new Map(), DT);
    expect(b!.pos.x).toBeGreaterThan(x0 + 0.2);
  });

  it('standing passengers block the aisle', () => {
    const s = gameWith('crowd');
    expect(s.standers).toHaveLength(CONFIG.challenge.crowdCount);
    const a = s.players[0]!;
    const st = s.standers[0]!;
    // Walk straight into a passenger for a while.
    for (let i = 0; i < 120 && s.phase === 'riding'; i++) {
      const dx = st.pos.x - a.pos.x;
      const dz = st.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      step(s, new Map([['a', { moveX: dx / d, moveZ: dz / d, action: false }]]), DT);
      if (a.seatId === null) expect(Math.hypot(a.pos.x - st.pos.x, a.pos.z - st.pos.z)).toBeGreaterThanOrEqual(CONFIG.player.radius + CONFIG.challenge.standerRadius - 1e-6);
    }
  });

  it('one-side doors: passengers board through the open side and stand in the aisle', () => {
    const s = gameWith('oneSideDoors');
    expect(s.doorSide === 1 || s.doorSide === -1).toBe(true);
    runUntil(s, (x) => x.phase === 'scramble');
    expect(s.standers).toHaveLength(CONFIG.challenge.boardingCount);
    for (const st of s.standers) expect(Math.sign(st.pos.z)).toBe(s.doorSide);
    runUntil(s, (x) => x.time > x.phaseEndsAt - 6);
    for (const st of s.standers) expect(Math.abs(st.target.z)).toBeLessThanOrEqual(0.36);
  });

  it('clears challenges when the next stop starts', () => {
    const s = gameWith('crowd');
    const a = s.players[0]!;
    runUntil(s, (x) => x.phase === 'scramble');
    a.pos = seatFront(s.seats[s.freeSeatIds[0]!]!);
    step(s, new Map([['a', press]]), DT);
    runUntil(s, (x) => x.phase === 'riding' && x.round === 1);
    expect(s.standers.every((st) => st.id > 0)).toBe(true);
    if (s.challenge !== 'crowd') expect(s.standers).toHaveLength(0);
  });
});

describe('kick fight and wet floor', () => {
  it('kick fight: a standing player kicks a seated one off and takes the seat', () => {
    const s = gameWith('kickFight');
    runUntil(s, (x) => x.phase === 'scramble');
    const [a, b] = s.players;
    const seat = s.seats[s.freeSeatIds[0]!]!;
    // a sits; b walks up to the seat and kicks.
    a!.pos = seatFront(seat);
    step(s, new Map([['a', press]]), DT);
    expect(a!.seatId).toBe(seat.id);
    b!.pos = { ...seatFront(seat) };
    b!.pushReadyAt = 0;
    const ev = step(s, new Map([['b', press]]), DT);
    expect(ev).toContainEqual({ type: 'seatKick', by: 'b', target: 'a', seatId: seat.id });
    expect(ev).toContainEqual({ type: 'points', playerId: 'b', amount: CONFIG.points.kick, reason: 'kick' });
    expect(a!.seatId).toBeNull();
    expect(s.time < a!.stunnedUntil).toBe(true);
    expect(seat.playerId).toBeNull();
    step(s, new Map([['b', press]]), DT);
    expect(b!.seatId).toBe(seat.id);
    // The scramble does not end early while seats can still change hands.
    for (const p of s.players) {
      const free = s.seats.find((x) => !x.npc && x.playerId === null && !x.priority);
      if (p.seatId === null && free) {
        p.pos = seatFront(free);
        step(s, new Map([[p.id, press]]), DT);
      }
    }
    expect(s.phase).toBe('scramble');
  });

  it('kick fight: kicks the player right in front even with an empty seat next to them', () => {
    const s = gameWith('kickFight');
    runUntil(s, (x) => x.phase === 'scramble');
    const [a, b] = s.players;
    // An empty seat right next to an occupied one.
    const seat = s.seats.find((x) => !x.priority && !x.npc && x.playerId === null && s.seats.some((y) => y.side === x.side && Math.abs(y.x - x.x - CONFIG.car.seatWidth) < 0.01 && !y.priority))!;
    const next = s.seats.find((y) => y.side === seat.side && Math.abs(y.x - seat.x - CONFIG.car.seatWidth) < 0.01)!;
    next.npc = false;
    next.playerId = 'a';
    a!.seatId = next.id;
    a!.pos = seatSitPos(next);
    seat.npc = false;
    seat.playerId = null;
    // Between the two, a bit closer to the occupied seat: both are in reach.
    const f = seatFront(next);
    b!.pos = { x: f.x - 0.3, z: f.z };
    b!.pushReadyAt = 0;
    const ev = step(s, new Map([['b', press]]), DT);
    expect(ev.some((e) => e.type === 'seatKick' && e.target === 'a')).toBe(true);
  });

  it('no kicking off seats outside a kick fight', () => {
    const s = gameWith('crowd');
    runUntil(s, (x) => x.phase === 'scramble');
    const [a, b] = s.players;
    const seat = s.seats[s.freeSeatIds[0]!]!;
    a!.pos = seatFront(seat);
    step(s, new Map([['a', press]]), DT);
    b!.pos = { ...seatFront(seat) };
    const ev = step(s, new Map([['b', press]]), DT);
    expect(ev.some((e) => e.type === 'seatKick')).toBe(false);
    expect(a!.seatId).toBe(seat.id);
  });

  it('running onto a puddle makes you slip and shoot off a good way', () => {
    const s = gameWith('puddles');
    expect(s.puddles).toHaveLength(CONFIG.challenge.puddleCount);
    const d = s.puddles[0]!;
    s.phaseEndsAt = Infinity;
    s.standers = [];
    const a = s.players[0]!;
    // Run toward the puddle from the left.
    a.pos = { x: d.x - d.r - 1.2, z: d.z };
    a.vel = { x: 0, z: 0 };
    s.players.slice(1).forEach((p, i) => (p.pos = { x: 20, z: i - 1 })); // out of the way
    s.puddles = [d];
    const run = new Map([['a', { moveX: 1, moveZ: 0, action: false }]]);
    let slippedAt: number | null = null;
    for (let i = 0; i < 90 && slippedAt === null; i++) {
      const ev = step(s, run, DT);
      if (ev.some((e) => e.type === 'slipped' && e.playerId === 'a')) slippedAt = a.pos.x;
    }
    expect(slippedAt).not.toBeNull();
    expect(s.time < a.slipUntil).toBe(true);
    // Out of control: steering the other way does nothing, and the slide goes far.
    const back = new Map([['a', { moveX: -1, moveZ: 0, action: false }]]);
    for (let i = 0; i < Math.round(CONFIG.challenge.slipTime / DT); i++) step(s, back, DT);
    expect(a.pos.x - slippedAt!).toBeGreaterThan(3);
  });

  it('walking slowly over a puddle is safe', () => {
    const s = gameWith('puddles');
    const d = s.puddles[0]!;
    s.phaseEndsAt = Infinity;
    const a = s.players[0]!;
    a.pos = { x: d.x - d.r - 0.3, z: d.z };
    a.vel = { x: 0, z: 0 };
    const creep = new Map([['a', { moveX: 0.2, moveZ: 0, action: false }]]);
    for (let i = 0; i < 60; i++) expect(step(s, creep, DT).some((e) => e.type === 'slipped')).toBe(false);
  });
});

describe('points', () => {
  it('scores rounds survived, the win and kicks; and carries over from the last game', () => {
    const setups = four.map((p, i) => ({ ...p, score: i === 0 ? 120 : 0 }));
    const s = createGame(setups, 9);
    expect(s.players[0]!.score).toBe(120);
    const brains = new Map(s.players.map((p, i) => [p.id, createBrain(i + 1)]));
    const ev: GameEvent[] = [];
    for (let i = 0; i < 60 * 600 && s.phase !== 'gameOver'; i++) {
      const inputs = new Map(s.players.map((p) => [p.id, botThink(s, p, brains.get(p.id)!, DT)]));
      ev.push(...step(s, inputs, DT));
    }
    expect(s.phase).toBe('gameOver');
    for (const p of s.players) {
      const earned = ev.filter((e) => e.type === 'points' && e.playerId === p.id).reduce((n, e) => n + (e.type === 'points' ? e.amount : 0), 0);
      expect(p.score).toBe((p.id === 'a' ? 120 : 0) + earned);
    }
    const winner = s.players.find((p) => p.id === s.winnerId)!;
    expect(ev).toContainEqual({ type: 'points', playerId: winner.id, amount: CONFIG.points.win, reason: 'win' });
    // Survived every round: 3 rounds for 4 players (no replays counted twice).
    const rounds = ev.filter((e) => e.type === 'points' && e.playerId === winner.id && e.reason === 'round').length;
    expect(rounds).toBeGreaterThanOrEqual(3);
  });
});

describe('iced coffee', () => {
  it('makes you run faster for a few seconds', () => {
    const s = gameWith('crowd');
    s.standers = [];
    s.phaseEndsAt = Infinity;
    const [a, b] = s.players;
    a!.pos = { x: -6, z: -0.9 };
    b!.pos = { x: -6, z: 0.9 };
    s.powerUps = [{ id: 99, kind: 'coffee', pos: { ...a!.pos } }];
    const ev = step(s, new Map(), DT);
    expect(ev).toContainEqual({ type: 'powerUp', playerId: 'a', kind: 'coffee' });
    const run = { moveX: 1, moveZ: 0, action: false };
    for (let i = 0; i < 60; i++) step(s, new Map([['a', run], ['b', run]]), DT);
    expect(a!.pos.x - b!.pos.x).toBeGreaterThan(1);
    expect(a!.vel.x).toBeCloseTo(CONFIG.player.speed * CONFIG.powerUp.boostSpeed, 1);
  });
});

describe('power-ups', () => {
  it('1 to 3 lie on the floor every stop, apart, and are picked up by walking over them', () => {
    const counts = new Set<number>();
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = createGame(four, seed);
      runUntil(s, (x) => x.phase === 'riding');
      expect(s.powerUps.length).toBeGreaterThanOrEqual(1);
      expect(s.powerUps.length).toBeLessThanOrEqual(3);
      counts.add(s.powerUps.length);
      for (const u of s.powerUps) kinds.add(u.kind);
    }
    expect([...counts].sort()).toEqual([1, 2, 3]);
    expect([...kinds].sort()).toEqual(['coffee', 'earphones', 'mbg', 'sleep']);
    const s = createGame(four, 11);
    runUntil(s, (x) => x.phase === 'riding');
    const n = s.powerUps.length;
    const item = s.powerUps[0]!;
    const a = s.players[0]!;
    a.pos = { ...item.pos };
    const ev = step(s, new Map(), DT);
    expect(ev).toContainEqual({ type: 'powerUp', playerId: 'a', kind: item.kind });
    expect(s.powerUps).toHaveLength(n - 1);
  });

  it('the MBG tray is spoiled: green and slow for a few seconds', () => {
    const s = createGame(four, 11);
    runUntil(s, (x) => x.phase === 'riding');
    const a = s.players[0]!;
    const b = s.players[1]!;
    s.standers = [];
    s.puddles = [];
    s.brakeAt = null;
    a.pos = { x: -6, z: 0.4 };
    b.pos = { x: -6, z: -0.4 };
    a.boostUntil = s.time + 3;
    s.powerUps = [{ id: 99, kind: 'mbg', pos: { ...a.pos } }];
    step(s, new Map(), DT);
    expect(a.sickUntil).toBeCloseTo(s.time + CONFIG.powerUp.sickTime, 1);
    expect(a.boostUntil).toBe(0); // spoils the coffee too
    const go = { moveX: 1, moveZ: 0, action: false };
    const ax = a.pos.x;
    const bx = b.pos.x;
    for (let i = 0; i < 60; i++) step(s, new Map([['a', go], ['b', go]]), DT);
    expect(a.pos.x - ax).toBeLessThan((b.pos.x - bx) * 0.7);
  });

  it('earphones make pushes bounce off', () => {
    const s = createGame(four, 3);
    runUntil(s, (x) => x.phase === 'riding');
    const [a, b] = s.players;
    s.standers = [];
    a!.pos = { x: 0, z: 0 };
    b!.pos = { x: 0.7, z: 0 };
    b!.shieldUntil = s.time + 3;
    const ev = step(s, new Map([['a', press]]), DT);
    expect(ev).toContainEqual({ type: 'shielded', playerId: 'b' });
    expect(s.time < b!.stunnedUntil).toBe(false);
    expect(a!.pushReadyAt).toBeGreaterThan(s.time); // the push was still spent
  });

  it('pretending to sleep keeps the priority seat once', () => {
    const s = createGame(four, 7);
    runUntil(s, (x) => x.phase === 'scramble');
    const [a, b] = s.players;
    a!.sleeping = true;
    a!.pos = seatFront(s.seats[s.trapSeatId!]!);
    b!.pos = seatFront(s.seats[s.freeSeatIds[0]!]!);
    const ev = step(s, new Map([['a', press], ['b', press]]), DT);
    expect(ev).toContainEqual({ type: 'slept', playerId: 'a', seatId: s.trapSeatId });
    expect(a!.sleeping).toBe(false);
    const rest = runUntil(s, (x) => x.phase === 'result');
    expect(rest.some((e) => e.type === 'kicked' && e.playerId === 'a')).toBe(false);
    expect(a!.eliminated).toBe(false);
  });
});

describe('bots with challenges', () => {
  it('still always finish with one winner, and do pick up power-ups', () => {
    let pickups = 0;
    let slept = 0;
    let longest = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const s = createGame(four, seed);
      const brains = new Map(s.players.map((p, i) => [p.id, createBrain(seed * 10 + i)]));
      let ticks = 0;
      while (s.phase !== 'gameOver') {
        const inputs = new Map(s.players.map((p) => [p.id, botThink(s, p, brains.get(p.id)!, DT)]));
        for (const e of step(s, inputs, DT)) {
          if (e.type === 'powerUp') pickups++;
          if (e.type === 'slept') slept++;
        }
        const taken = s.seats.filter((x) => x.playerId !== null).map((x) => x.playerId);
        expect(new Set(taken).size).toBe(taken.length);
        if (++ticks > 60 * 60 * 5) throw new Error(`seed ${seed} did not finish`);
      }
      longest = Math.max(longest, s.time);
      expect(alivePlayers(s)).toHaveLength(1);
    }
    expect(pickups).toBeGreaterThan(100);
    expect(slept).toBeGreaterThan(0);
    expect(longest).toBeLessThan(180);
  });
});

import { describe, expect, it } from 'vitest';
import { botThink, createBrain } from '../src/ai/bot';
import { CONFIG } from '../src/core/config';
import { alivePlayers, createGame, step } from '../src/core/game';
import { createSeats, seatFront } from '../src/core/layout';
import type { GameEvent, GameState, PlayerInput, PlayerSetup } from '../src/core/types';

const DT = 1 / CONFIG.tickRate;
const four: PlayerSetup[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), isBot: true }));

function runUntil(s: GameState, phase: GameState['phase'], inputs = new Map<string, PlayerInput>()): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < 60 * 60 && s.phase !== phase; i++) all.push(...step(s, inputs, DT));
  return all;
}

describe('layout', () => {
  it('builds 40 seats, 12 of them priority, no overlaps', () => {
    const seats = createSeats();
    expect(seats).toHaveLength(40);
    expect(seats.filter((s) => s.priority)).toHaveLength(12);
    for (const side of [-1, 1]) {
      const xs = seats.filter((s) => s.side === side).map((s) => s.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(CONFIG.car.seatWidth - 1e-9);
      for (const x of xs) for (const d of CONFIG.car.doorsX) expect(Math.abs(x - d)).toBeGreaterThan(CONFIG.car.doorHalfWidth);
    }
  });
});

describe('createGame', () => {
  it('rejects bad player lists', () => {
    expect(() => createGame(four.slice(0, 1), 1)).toThrow();
    expect(() => createGame([...four, { id: 'e', name: 'E', isBot: true }], 1)).toThrow();
    expect(() => createGame([four[0]!, four[0]!], 1)).toThrow();
  });

  it('is deterministic for the same seed', () => {
    const a = createGame(four, 42);
    const b = createGame(four, 42);
    runUntil(a, 'scramble');
    runUntil(b, 'scramble');
    expect(a.freeSeatIds).toEqual(b.freeSeatIds);
    expect(a.players.map((p) => p.pos)).toEqual(b.players.map((p) => p.pos));
  });
});

describe('a round', () => {
  it('opens exactly alive-1 normal seats plus one priority trap', () => {
    const s = createGame(four, 7);
    runUntil(s, 'scramble');
    expect(s.freeSeatIds).toHaveLength(3);
    expect(s.freeSeatIds.every((id) => !s.seats[id]!.priority && !s.seats[id]!.npc)).toBe(true);
    expect(s.trapSeatId).not.toBeNull();
    expect(s.seats[s.trapSeatId!]!.priority).toBe(true);
  });

  it('lets a player sit only when close to a free seat', () => {
    const s = createGame(four, 7);
    runUntil(s, 'scramble');
    const p = s.players[0]!;
    const seat = s.seats[s.freeSeatIds[0]!]!;
    p.pos = { x: seat.x + 3, z: 0 };
    step(s, new Map([['a', { moveX: 0, moveZ: 0, action: true }]]), DT);
    expect(p.seatId).toBeNull();
    p.pos = seatFront(seat);
    const ev = step(s, new Map([['a', { moveX: 0, moveZ: 0, action: true }]]), DT);
    expect(p.seatId).toBe(seat.id);
    expect(ev).toContainEqual({ type: 'sat', playerId: 'a', seatId: seat.id });
  });

  it('never seats two players on one seat', () => {
    const s = createGame(four, 7);
    runUntil(s, 'scramble');
    const seat = s.seats[s.freeSeatIds[0]!]!;
    s.players[0]!.pos = seatFront(seat);
    s.players[1]!.pos = { ...seatFront(seat), x: seat.x + 0.05 };
    for (const p of s.players.slice(2)) p.pos = { x: -11, z: 0 };
    const press = { moveX: 0, moveZ: 0, action: true };
    step(s, new Map([['a', press], ['b', press]]), DT);
    expect(s.players.filter((p) => p.seatId === seat.id)).toHaveLength(1);
  });

  it('kicks a player off the priority seat and eliminates them', () => {
    const s = createGame(four, 7);
    runUntil(s, 'scramble');
    const trap = s.seats[s.trapSeatId!]!;
    const a = s.players[0]!;
    const b = s.players[1]!;
    a.pos = seatFront(trap);
    b.pos = seatFront(s.seats[s.freeSeatIds[0]!]!);
    const press = { moveX: 0, moveZ: 0, action: true };
    step(s, new Map([['a', press], ['b', press]]), DT);
    expect(a.seatId).toBe(trap.id);
    expect(b.seatId).not.toBeNull();
    const ev = runUntil(s, 'result');
    expect(ev.some((e) => e.type === 'kicked' && e.playerId === 'a')).toBe(true);
    expect(a.eliminated).toBe(true);
  });

  it('replays the stop when nobody sits', () => {
    const s = createGame(four, 7);
    const ev = runUntil(s, 'result');
    expect(ev).toContainEqual({ type: 'replay' });
    expect(alivePlayers(s)).toHaveLength(4);
    runUntil(s, 'riding');
    expect(s.round).toBe(0);
  });

  it('keeps standing players inside the car under sway, braking and pushes', () => {
    const s = createGame(four, 3);
    const hard = new Map(four.map((p, i) => [p.id, { moveX: i % 2 ? 1 : -1, moveZ: i < 2 ? 1 : -1, action: true }]));
    for (let i = 0; i < 60 * 12; i++) {
      step(s, hard, DT);
      for (const p of s.players) {
        if (p.seatId !== null || p.eliminated) continue;
        expect(Math.abs(p.pos.x)).toBeLessThanOrEqual(CONFIG.car.halfLength);
        expect(Math.abs(p.pos.z)).toBeLessThanOrEqual(CONFIG.car.aisleHalfWidth);
      }
    }
  });

  it('ignores garbage input values', () => {
    const s = createGame(four, 3);
    runUntil(s, 'riding');
    step(s, new Map([['a', { moveX: NaN, moveZ: Infinity, action: false }]]), DT);
    expect(Number.isFinite(s.players[0]!.pos.x)).toBe(true);
    expect(Number.isFinite(s.players[0]!.pos.z)).toBe(true);
  });
});

describe('full bot games', () => {
  it('always ends with exactly one winner, one elimination round at a time', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = createGame(four, seed);
      const brains = new Map(s.players.map((p, i) => [p.id, createBrain(seed * 10 + i)]));
      let ticks = 0;
      while (s.phase !== 'gameOver') {
        const inputs = new Map(s.players.map((p) => [p.id, botThink(s, p, brains.get(p.id)!, DT)]));
        step(s, inputs, DT);
        const taken = s.seats.filter((x) => x.playerId !== null).map((x) => x.playerId);
        expect(new Set(taken).size).toBe(taken.length);
        if (++ticks > 60 * 60 * 5) throw new Error(`seed ${seed} did not finish`);
      }
      expect(alivePlayers(s)).toHaveLength(1);
      expect(s.winnerId).toBe(alivePlayers(s)[0]!.id);
    }
  });
});

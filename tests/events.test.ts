import { describe, expect, it } from 'vitest';
import { botThink, createBrain } from '../src/ai/bot';
import { CONFIG } from '../src/core/config';
import { alivePlayers, createGame, npcKickSeat, step } from '../src/core/game';
import { seatFront } from '../src/core/layout';
import { applySnapshot, packSnapshot, parseHostMsg } from '../src/net/protocol';
import type { GameEvent, GameState, PlayerInput, PlayerSetup } from '../src/core/types';

const DT = 1 / CONFIG.tickRate;
const C = CONFIG.challenge;
const four: PlayerSetup[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, isBot: true }));
const press: PlayerInput = { moveX: 0, moveZ: 0, action: true };

function runUntil(s: GameState, done: (s: GameState) => boolean, inputs = new Map<string, PlayerInput>()): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < 60 * 120 && !done(s); i++) all.push(...step(s, inputs, DT));
  return all;
}

/** Steps with bots playing, until `done`. */
function botsUntil(s: GameState, done: (s: GameState) => boolean, seed = 1): GameEvent[] {
  const brains = new Map(s.players.map((p, i) => [p.id, createBrain(seed * 7 + i)]));
  const all: GameEvent[] = [];
  for (let i = 0; i < 60 * 600 && !done(s) && s.phase !== 'gameOver'; i++) {
    const inputs = new Map(s.players.map((p) => [p.id, botThink(s, p, brains.get(p.id)!, DT)]));
    all.push(...step(s, inputs, DT));
  }
  return all;
}

/** Plays whole games with bots and collects what happened at every stop. */
function botGame(seed: number) {
  const s = createGame(four, seed);
  const brains = new Map(s.players.map((p, i) => [p.id, createBrain(seed * 7 + i)]));
  const stops: Array<{ round: number; challenge: string | null; final: boolean; scramble: number }> = [];
  const events: GameEvent[] = [];
  let scrambleStart = 0;
  for (let i = 0; i < 60 * 600 && s.phase !== 'gameOver'; i++) {
    const inputs = new Map(s.players.map((p) => [p.id, botThink(s, p, brains.get(p.id)!, DT)]));
    const before = s.phase;
    const ev = step(s, inputs, DT);
    events.push(...ev);
    if (before === 'riding' && s.phase === 'scramble') {
      scrambleStart = s.time;
      stops.push({ round: s.round, challenge: s.challenge, final: s.round + 2 >= s.route.length, scramble: s.phaseEndsAt - s.time });
    }
    void scrambleStart;
  }
  return { s, stops, events };
}

describe('rush hour', () => {
  it('never at the first or the last stop, at most twice a game, with a longer scramble', () => {
    let seen = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { s, stops } = botGame(seed);
      expect(s.phase).toBe('gameOver');
      const rush = stops.filter((x) => x.challenge === 'rushHour');
      expect(rush.length).toBeLessThanOrEqual(C.rushMax);
      for (const r of rush) {
        expect(r.round).toBeGreaterThanOrEqual(1);
        expect(r.final).toBe(false);
        expect(r.scramble).toBeGreaterThanOrEqual(CONFIG.phase.scramble + C.rushExtraTime - 1e-6);
      }
      seen += rush.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('fills the aisle with passengers you squeeze through slowly', () => {
    let s: GameState | null = null;
    for (let seed = 1; seed < 400 && !s; seed++) {
      const g = createGame(four, seed);
      botsUntil(g, (x) => (x.challenge === 'rushHour' && x.phase === 'riding') || x.round > 4, seed);
      if (g.challenge === 'rushHour') s = g;
    }
    expect(s).not.toBeNull();
    const g = s!;
    expect(g.standers).toHaveLength(C.rushCount);
    for (const st of g.standers) expect(Math.abs(st.pos.z)).toBeLessThanOrEqual(C.rushLane + 1e-6);
    // Walk the length of the car: you get through, but slower than on an empty aisle.
    const a = g.players[0]!;
    a.pos = { x: -9, z: 0 };
    const go = new Map([['a', { moveX: 1, moveZ: 0, action: false }]]);
    const x0 = a.pos.x;
    for (let i = 0; i < 120; i++) step(g, go, DT);
    const crowded = a.pos.x - x0;
    expect(crowded).toBeGreaterThan(0.5);
    expect(crowded).toBeLessThan(CONFIG.player.speed * 2 * 0.95);
  });
});

/** A game at the start of a scramble with a moving priority seat scheduled. */
function withSeatMove(): GameState {
  for (let seed = 1; seed < 800; seed++) {
    const s = createGame(four, seed);
    botsUntil(s, (x) => (x.phase === 'scramble' && x.seatMove !== null && x.time < x.seatMove.at - 1.6) || x.round > 4, seed);
    if (s.seatMove) return s;
  }
  throw new Error('no seat move found');
}

describe('moving priority seat', () => {
  it('blinks first, then a free seat becomes priority and the old corner seat a normal one', () => {
    const s = withSeatMove();
    const m = s.seatMove!;
    const oldTrap = s.trapSeatId!;
    expect(s.seats[oldTrap]!.priority).toBe(true);
    expect(m.seatIds.length).toBeGreaterThanOrEqual(1);
    for (const id of m.seatIds) expect(s.seats[id]!.priority).toBe(false);
    expect(s.phaseEndsAt - s.time).toBeGreaterThan(CONFIG.phase.scramble);
    // Someone sits on the seat that will turn red.
    const seat = s.seats[m.seatIds[0]!]!;
    const a = s.players[0]!;
    a.pos = seatFront(seat);
    const ev = runUntil(s, (x) => x.players[0]!.seatId !== null, new Map([['a', press]]));
    expect(ev.some((e) => e.type === 'sat' && e.playerId === 'a')).toBe(true);
    const all = runUntil(s, (x) => x.seatMove!.done);
    const warn = all.findIndex((e) => e.type === 'seatMoveWarn');
    const moved = all.findIndex((e) => e.type === 'seatMoved');
    expect(warn).toBeGreaterThanOrEqual(0);
    expect(moved).toBeGreaterThan(warn);
    expect(seat.priority).toBe(true);
    expect(s.seats[oldTrap]!.priority).toBe(false);
    expect(s.freeSeatIds).toContain(oldTrap);
    // Asked to stand, with a little extra time to find another seat.
    expect(a.kickAt).toBeCloseTo(s.time + CONFIG.priorityKickDelay + C.seatMoveGrace, 1);
    runUntil(s, (x) => x.players[0]!.kickAt === null);
    expect(a.seatId).toBeNull();
  });

  it('priority seats are back in the corners at the next stop', () => {
    const s = withSeatMove();
    const base = createGame(four, 1).seats.map((x) => x.priority);
    runUntil(s, (x) => x.seatMove?.done === true);
    expect(s.seats.map((x) => x.priority)).not.toEqual(base);
    runUntil(s, (x) => x.phase === 'riding' || x.phase === 'gameOver');
    expect(s.seats.map((x) => x.priority)).toEqual(base);
  });
});

/** Scramble with player 'a' standing right in front of a seated passenger. */
function besideNpc(): { s: GameState; seatId: number } {
  for (let seed = 1; seed < 200; seed++) {
    const s = createGame(four, seed);
    runUntil(s, (x) => x.phase === 'scramble');
    const seat = s.seats.find((x) => x.npc && !x.priority);
    if (!seat) continue;
    const a = s.players[0]!;
    a.pos = seatFront(seat);
    // Nobody else close enough to be pushed instead.
    s.players.slice(1).forEach((p, i) => (p.pos = { x: seat.x > 0 ? -8 + i : 8 - i, z: 0 }));
    return { s, seatId: seat.id };
  }
  throw new Error('no seated passenger');
}

describe('kicking seated passengers', () => {
  it('first time: you get the seat but lose 20 points', () => {
    const { s, seatId } = besideNpc();
    const a = s.players[0]!;
    a.score = 35;
    expect(npcKickSeat(s, a)?.id).toBe(seatId);
    const ev = step(s, new Map([['a', press]]), DT);
    expect(ev).toContainEqual({ type: 'npcKick', playerId: 'a', seatId, strike: 1 });
    expect(ev).toContainEqual({ type: 'points', playerId: 'a', amount: -C.npcKickPenalty, reason: 'penalty' });
    expect(a.seatId).toBe(seatId);
    expect(s.seats[seatId]!.npc).toBe(false);
    expect(a.score).toBe(15);
    expect(a.npcStrikes).toBe(1);
  });

  it('points never go below zero', () => {
    const { s } = besideNpc();
    const a = s.players[0]!;
    a.score = 5;
    step(s, new Map([['a', press]]), DT);
    expect(a.score).toBe(0);
  });

  it('second time in the same game: the officer takes you off the train', () => {
    const { s, seatId } = besideNpc();
    const a = s.players[0]!;
    a.npcStrikes = 1;
    const ev = step(s, new Map([['a', press]]), DT);
    expect(ev).toContainEqual({ type: 'escorted', playerId: 'a', seatId });
    expect(a.eliminated).toBe(true);
    expect(a.seatId).toBeNull();
    expect(s.seats[seatId]!.npc).toBe(true); // the passenger keeps the seat
    expect(alivePlayers(s)).toHaveLength(3);
  });

  it('strikes start again in the next game', () => {
    const next = createGame([{ id: 'a', name: 'a', isBot: false, score: 40 }, ...four.slice(1)], 5);
    expect(next.players[0]!.npcStrikes).toBe(0);
  });

  it('only on ordinary seats, and only during the scramble', () => {
    const { s, seatId } = besideNpc();
    const a = s.players[0]!;
    s.seats[seatId]!.priority = true;
    expect(npcKickSeat(s, a)).toBeUndefined();
    s.seats[seatId]!.priority = false;
    s.phase = 'riding';
    expect(npcKickSeat(s, a)).toBeUndefined();
  });
});

describe('network', () => {
  it('syncs strikes, moved priority seats and the blinking warning', () => {
    const s = withSeatMove();
    runUntil(s, (x) => x.seatMove!.done);
    s.players[1]!.npcStrikes = 1;
    const msg = parseHostMsg(JSON.stringify({ t: 'snap', s: packSnapshot(s) }));
    expect(msg?.t).toBe('snap');
    const copy = createGame(four, 999);
    applySnapshot(copy, (msg as { s: ReturnType<typeof packSnapshot> }).s);
    expect(copy.players[1]!.npcStrikes).toBe(1);
    expect(copy.seats.map((x) => x.priority)).toEqual(s.seats.map((x) => x.priority));
    expect(copy.seatMove).toEqual({ ...s.seatMove, at: expect.closeTo(s.seatMove!.at, 3) });
  });

  it('accepts the new events', () => {
    const events: GameEvent[] = [
      { type: 'npcKick', playerId: 'a', seatId: 3, strike: 2 },
      { type: 'escorted', playerId: 'a', seatId: 3 },
      { type: 'seatMoveWarn', seatIds: [1, 4] },
      { type: 'seatMoved', seatIds: [1] },
      { type: 'points', playerId: 'a', amount: -20, reason: 'penalty' },
      { type: 'challenge', kind: 'rushHour' },
    ];
    expect(parseHostMsg(JSON.stringify({ t: 'ev', e: events }))).toEqual({ t: 'ev', e: events });
  });
});

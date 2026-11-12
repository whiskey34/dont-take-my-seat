import { describe, expect, it } from 'vitest';
import { botThink, createBrain } from '../src/ai/bot';
import { CONFIG } from '../src/core/config';
import { alivePlayers, createGame, isFinalStop, seatsThisStop, step } from '../src/core/game';
import { seatFront } from '../src/core/layout';
import { applySnapshot, packSnapshot, parseHostMsg } from '../src/net/protocol';
import type { GameEvent, GameState, PlayerInput, PlayerSetup } from '../src/core/types';

const DT = 1 / CONFIG.tickRate;
const C = CONFIG.challenge;
const four: PlayerSetup[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, isBot: true }));
const press: PlayerInput = { moveX: 0, moveZ: 0, action: true };

function runUntil(s: GameState, done: (s: GameState) => boolean, inputs = new Map<string, PlayerInput>()): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < 60 * 300 && !done(s); i++) all.push(...step(s, inputs, DT));
  return all;
}

const hunters = (s: GameState) => s.standers.filter((st) => st.hunt);

describe('seat hunters', () => {
  it('one to three passengers per stop race for a seat, each bringing an extra seat', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = createGame(four, seed);
      runUntil(s, (x) => x.phase === 'riding');
      const h = hunters(s);
      expect(h.length).toBeGreaterThanOrEqual(C.hunters[0]);
      expect(h.length).toBeLessThanOrEqual(C.huntersRush[1]);
      expect(h.filter((st) => st.hunt!.elder).length).toBeLessThanOrEqual(1);
      const extra = h.filter((st) => !st.hunt!.elder).length;
      runUntil(s, (x) => x.phase === 'scramble');
      expect(s.freeSeatIds).toHaveLength(seatsThisStop(s) + extra);
    }
  });

  it('nobody hunts at the last stop', () => {
    const s = createGame(four, 4);
    s.round = s.route.length - 2;
    runUntil(s, (x) => x.phase === 'riding');
    // The intro starts round 0; jump to the last stop instead.
    s.round = s.route.length - 3;
    runUntil(s, (x) => x.phase === 'riding' && isFinalStop(x));
    expect(hunters(s)).toHaveLength(0);
  });

  it('a hunter runs to a free seat after the doors open and sits down', () => {
    const s = createGame(four, 9);
    runUntil(s, (x) => x.phase === 'riding');
    const h = hunters(s)[0]!;
    const start = { ...h.pos };
    runUntil(s, (x) => x.phase === 'scramble');
    // Still waiting for a moment after the doors open.
    expect(Math.hypot(h.pos.x - start.x, h.pos.z - start.z)).toBeLessThan(0.05);
    const ev = runUntil(s, (x) => !x.standers.includes(h) || x.phase !== 'scramble');
    const sat = ev.find((e) => e.type === 'npcSat');
    expect(sat).toBeDefined();
    const seat = s.seats[(sat as { seatId: number }).seatId]!;
    expect(seat.npc).toBe(true);
    expect(seat.playerId).toBeNull();
    expect(seat.priority).toBe(h.hunt!.elder);
  });

  it('elderly hunters go for a priority seat and keep it', () => {
    for (let seed = 1; seed < 300; seed++) {
      const s = createGame(four, seed);
      runUntil(s, (x) => x.phase === 'riding');
      const elder = hunters(s).find((st) => st.hunt!.elder);
      if (!elder) continue;
      const ev = runUntil(s, (x) => x.phase !== 'scramble' && x.phase !== 'riding');
      const sat = ev.filter((e) => e.type === 'npcSat').map((e) => s.seats[(e as { seatId: number }).seatId]!);
      if (s.standers.includes(elder)) continue; // a player got there first
      expect(sat.some((seat) => seat.priority && seat.npc)).toBe(true);
      return;
    }
    throw new Error('no elderly hunter found');
  });

  it('a push knocks a hunter back and dazes it', () => {
    const s = createGame(four, 9);
    runUntil(s, (x) => x.phase === 'scramble');
    const h = hunters(s)[0]!;
    const a = s.players[0]!;
    s.players.slice(1).forEach((p, i) => (p.pos = { x: h.pos.x > 0 ? -8 + i : 8 - i, z: 0 }));
    a.pos = { x: h.pos.x - 0.6, z: h.pos.z };
    a.pushReadyAt = 0;
    const before = h.pos.x;
    const ev = step(s, new Map([['a', press]]), DT);
    expect(ev).toContainEqual({ type: 'npcPushed', by: 'a' });
    expect(h.hunt!.stunUntil).toBeGreaterThan(s.time + C.hunterStun - 0.1);
    runUntil(s, (x) => x.time > x.time - 1 && x.time >= h.hunt!.stunUntil - 0.5);
    expect(h.pos.x).toBeGreaterThan(before + 0.3);
  });

  it('players cannot take a seat a hunter is sitting on', () => {
    const s = createGame(four, 9);
    const ev = runUntil(s, (x) => x.phase === 'scramble' && x.standers.every((st) => !st.hunt));
    const sat = ev.find((e) => e.type === 'npcSat') as { seatId: number } | undefined;
    if (!sat) return;
    const a = s.players[0]!;
    a.pos = seatFront(s.seats[sat.seatId]!);
    step(s, new Map([['a', { moveX: 0, moveZ: 0, action: false }]]), DT);
    expect(s.seats[sat.seatId]!.npc).toBe(true);
  });

  it('syncs hunters to clients', () => {
    const s = createGame(four, 9);
    runUntil(s, (x) => x.phase === 'riding');
    const msg = parseHostMsg(JSON.stringify({ t: 'snap', s: packSnapshot(s) }));
    const copy = createGame(four, 1);
    applySnapshot(copy, (msg as { s: ReturnType<typeof packSnapshot> }).s);
    expect(hunters(copy).map((st) => [st.id, st.hunt!.elder])).toEqual(hunters(s).map((st) => [st.id, st.hunt!.elder]));
    expect(parseHostMsg(JSON.stringify({ t: 'ev', e: [{ type: 'npcSat', seatId: 3 }, { type: 'npcPushed', by: 'a' }] }))).not.toBeNull();
  });

  it('200 bot games: always one winner, never two on a seat, about the same length', () => {
    let total = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const s = createGame(four, seed);
      const brains = new Map(s.players.map((p, i) => [p.id, createBrain(seed * 7 + i)]));
      for (let i = 0; i < 60 * 400 && s.phase !== 'gameOver'; i++) {
        step(s, new Map(s.players.map((p) => [p.id, botThink(s, p, brains.get(p.id)!, DT)])), DT);
        const taken = s.players.filter((p) => p.seatId !== null).map((p) => p.seatId);
        expect(new Set(taken).size).toBe(taken.length);
        for (const id of taken) expect(s.seats[id!]!.npc).toBe(false);
      }
      expect(s.phase).toBe('gameOver');
      expect(alivePlayers(s).length).toBeLessThanOrEqual(1);
      total += s.time;
    }
    const avg = total / 200;
    expect(avg).toBeGreaterThan(20);
    expect(avg).toBeLessThan(75);
    console.log(`average game: ${avg.toFixed(1)} s`);
  });
});

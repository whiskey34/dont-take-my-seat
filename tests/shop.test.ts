import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/core/config';
import { canUseItem, createGame, seatInReach, step } from '../src/core/game';
import { seatFront } from '../src/core/layout';
import { applySnapshot, packSnapshot, parseClientMsg, parseHostMsg } from '../src/net/protocol';
import { ACCESSORIES, cleanLook, randomLook } from '../src/shop/catalog';
import { buyAccessory, buyItem, coinsForGame, earn, itemUsed, loadShop, saveShop, toggleCarry, toggleWear, type ShopData } from '../src/shop/wallet';
import type { GameEvent, GameState, ItemKind, PlayerInput, PlayerSetup } from '../src/core/types';

const DT = 1 / CONFIG.tickRate;
const use: PlayerInput = { moveX: 0, moveZ: 0, action: false, useItem: true };
const press: PlayerInput = { moveX: 0, moveZ: 0, action: true };

function game(item: ItemKind | null, seed = 9): GameState {
  const setups: PlayerSetup[] = [
    { id: 'a', name: 'A', isBot: false, item, look: { head: 'cap-red' } },
    ...['b', 'c', 'd'].map((id) => ({ id, name: id, isBot: true })),
  ];
  return createGame(setups, seed);
}

function runUntil(s: GameState, done: (s: GameState) => boolean, inputs = new Map<string, PlayerInput>()): GameEvent[] {
  const all: GameEvent[] = [];
  for (let i = 0; i < 60 * 300 && !done(s); i++) all.push(...step(s, inputs, DT));
  return all;
}

/** Scramble, hunters gone, player b right next to a. */
function scrambleWithB(item: ItemKind): GameState {
  const s = game(item);
  runUntil(s, (x) => x.phase === 'scramble');
  s.standers = [];
  const [a, b, c, d] = s.players;
  a!.pos = { x: 0, z: 0 };
  b!.pos = { x: 0.6, z: 0 };
  c!.pos = { x: -8, z: 0 };
  d!.pos = { x: 8, z: 0 };
  return s;
}

describe('shop items in the game', () => {
  it('is brought into the game and used once', () => {
    const s = game('runShoes');
    const a = s.players[0]!;
    expect(a.item).toBe('runShoes');
    expect(a.look).toEqual({ head: 'cap-red' });
    expect(s.players[1]!.item).toBeNull();
    expect(canUseItem(s, a)).toBe(false); // not during the intro
    runUntil(s, (x) => x.phase === 'riding');
    const ev = step(s, new Map([['a', use]]), DT);
    expect(ev).toContainEqual({ type: 'itemUsed', playerId: 'a', kind: 'runShoes' });
    expect(a.item).toBeNull();
    expect(a.boostUntil).toBeGreaterThan(s.time + CONFIG.item.shoesTime - 0.1);
    expect(step(s, new Map([['a', use]]), DT).some((e) => e.type === 'itemUsed')).toBe(false);
  });

  it('jumbo backpack: the next push is much stronger, then it is gone', () => {
    const plain = scrambleWithB('jumboPack');
    step(plain, new Map([['a', press]]), DT);
    const normal = plain.players[1]!.vel.x;

    const s = scrambleWithB('jumboPack');
    step(s, new Map([['a', use]]), DT);
    expect(s.players[0]!.jumbo).toBe(true);
    step(s, new Map([['a', press]]), DT);
    expect(s.players[1]!.vel.x).toBeGreaterThan(normal * 1.5);
    expect(s.players[0]!.jumbo).toBe(false);
  });

  it('shoulder shove pushes everyone close, but not someone with earphones', () => {
    const s = scrambleWithB('shoulder');
    s.players[2]!.pos = { x: -0.9, z: 0.3 };
    s.players[3]!.pos = { x: 0, z: 1 };
    s.players[3]!.shieldUntil = s.time + 5;
    const ev = step(s, new Map([['a', use]]), DT);
    expect(ev).toContainEqual({ type: 'pushed', by: 'a', target: 'b' });
    expect(ev).toContainEqual({ type: 'pushed', by: 'a', target: 'c' });
    expect(ev).toContainEqual({ type: 'shielded', playerId: 'd' });
    expect(s.players[1]!.vel.x).toBeGreaterThan(0);
    expect(s.players[2]!.vel.x).toBeLessThan(0);
  });

  it('seat bag: only the owner can sit there for a moment', () => {
    const s = scrambleWithB('seatBag');
    const seat = s.seats[s.freeSeatIds.find((id) => !s.seats[id]!.priority)!]!;
    const a = s.players[0]!;
    const b = s.players[1]!;
    a.pos = { ...seatFront(seat), z: seatFront(seat).z * 0.2 };
    const ev = step(s, new Map([['a', use]]), DT);
    const used = ev.find((e) => e.type === 'itemUsed') as { seatId?: number } | undefined;
    expect(used?.seatId).toBeDefined();
    const bagged = s.seats[used!.seatId!]!;
    expect(bagged.bagBy).toBe('a');
    b.pos = seatFront(bagged);
    expect(seatInReach(s, b)?.id).not.toBe(bagged.id);
    a.pos = seatFront(bagged);
    b.pos = { x: 8, z: 0 };
    expect(seatInReach(s, a)?.id).toBe(bagged.id);
    // After the bag time anyone can sit there again.
    runUntil(s, (x) => x.time > bagged.bagUntil);
    b.pos = seatFront(bagged);
    if (bagged.playerId === null && !bagged.npc) expect(seatInReach(s, b)?.id).toBe(bagged.id);
  });

  it('seat bag needs an open seat nearby', () => {
    const s = scrambleWithB('seatBag');
    s.players[0]!.pos = { x: 0, z: 0 };
    for (const id of s.freeSeatIds) s.seats[id]!.npc = true;
    expect(canUseItem(s, s.players[0]!)).toBe(false);
  });

  it('ginger candy: the stale tray and puddles do nothing', () => {
    const s = scrambleWithB('ginger');
    const a = s.players[0]!;
    step(s, new Map([['a', use]]), DT);
    expect(a.ginger).toBe(true);
    s.powerUps = [{ id: 999, kind: 'mbg', pos: { ...a.pos } }];
    step(s, new Map(), DT);
    expect(a.sickUntil).toBeLessThanOrEqual(s.time);
    s.puddles = [{ x: a.pos.x + 0.5, z: a.pos.z, r: 1 }];
    a.vel = { x: 4, z: 0 };
    const ev = step(s, new Map([['a', { moveX: 1, moveZ: 0, action: false }]]), DT);
    expect(ev.some((e) => e.type === 'slipped')).toBe(false);
  });

  it('syncs items, outfits and seat bags to clients', () => {
    const s = scrambleWithB('seatBag');
    s.players[0]!.jumbo = true;
    const seat = s.seats[s.freeSeatIds[0]!]!;
    seat.bagBy = 'a';
    seat.bagUntil = s.time + 1;
    const start = parseHostMsg(JSON.stringify({ t: 'start', seed: 1, players: [{ id: 'a', name: 'A', isBot: false, look: { head: 'cap-red', face: 'nope' }, item: 'seatBag' }, { id: 'b', name: 'B', isBot: false, item: 'rocket' }], difficulty: 'normal' }));
    expect(start).toMatchObject({ players: [{ look: { head: 'cap-red' }, item: 'seatBag' }, { look: {}, item: null }] });
    const msg = parseHostMsg(JSON.stringify({ t: 'snap', s: packSnapshot(s) }));
    expect(msg?.t).toBe('snap');
    const copy = game(null, 1);
    applySnapshot(copy, (msg as { s: ReturnType<typeof packSnapshot> }).s);
    expect(copy.players[0]!.item).toBe('seatBag');
    expect(copy.players[0]!.jumbo).toBe(true);
    expect(copy.seats[seat.id]!.bagBy).toBe('a');
    expect(parseClientMsg(JSON.stringify({ t: 'use', s: 5 }))).toEqual({ t: 'use', s: 5 });
    expect(parseClientMsg(JSON.stringify({ t: 'hello', v: 13, name: 'x', k: 'k', g: { l: { body: 'shirt-pink' }, i: 'ginger' } }))).toMatchObject({ g: { l: { body: 'shirt-pink' }, i: 'ginger' } });
    expect(parseHostMsg(JSON.stringify({ t: 'ev', e: [{ type: 'itemUsed', playerId: 'a', kind: 'ginger' }] }))).not.toBeNull();
  });
});

describe('catalog', () => {
  it('has unique ids, and cleans looks from outside', () => {
    expect(new Set(ACCESSORIES.map((a) => a.id)).size).toBe(ACCESSORIES.length);
    expect(cleanLook({ head: 'shirt-pink', body: 'shirt-pink', face: 42 })).toEqual({ body: 'shirt-pink' });
    for (let i = 0; i < 20; i++) expect(cleanLook(randomLook(i))).toEqual(randomLook(i));
  });
});

describe('wallet', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  const fresh = (): ShopData => ({ coins: 0, owned: [], look: {}, bag: {}, carry: null });

  it('coins: one per 5 points plus a bonus for the top three', () => {
    expect(coinsForGame(80, 1)).toBe(26);
    expect(coinsForGame(30, 2)).toBe(11);
    expect(coinsForGame(-20, 4)).toBe(0);
  });

  it('buys, wears and takes off accessories', () => {
    const d = fresh();
    expect(buyAccessory(d, 'cap-red')).toBe(false); // no coins
    earn(d, 100);
    expect(buyAccessory(d, 'cap-red')).toBe(true);
    expect(d.coins).toBe(60);
    expect(d.look.head).toBe('cap-red');
    expect(buyAccessory(d, 'cap-red')).toBe(false); // owned already
    toggleWear(d, 'cap-red');
    expect(d.look.head).toBeUndefined();
    toggleWear(d, 'shirt-pink'); // not owned
    expect(d.look.body).toBeUndefined();
  });

  it('items: buy, bring one, used up', () => {
    const d = fresh();
    earn(d, 40);
    expect(buyItem(d, 'ginger')).toBe(true);
    expect(buyItem(d, 'ginger')).toBe(true);
    expect(buyItem(d, 'seatBag')).toBe(false);
    toggleCarry(d, 'seatBag');
    expect(d.carry).toBeNull();
    toggleCarry(d, 'ginger');
    expect(d.carry).toBe('ginger');
    itemUsed(d, 'ginger');
    expect(d.carry).toBe('ginger');
    itemUsed(d, 'ginger');
    expect(d.carry).toBeNull();
    expect(d.bag.ginger).toBeUndefined();
  });

  it('saves and loads, dropping anything broken', () => {
    const d = fresh();
    earn(d, 200);
    buyAccessory(d, 'hoodie-grey');
    buyItem(d, 'runShoes');
    toggleCarry(d, 'runShoes');
    saveShop(d);
    expect(loadShop()).toEqual(d);
    store.set('dtms.shop.v1', JSON.stringify({ coins: -5, owned: ['x', 'cap-red'], look: { head: 'cap-blue' }, bag: { runShoes: 'a', ginger: 2 }, carry: 'runShoes' }));
    expect(loadShop()).toEqual({ coins: 0, owned: ['cap-red'], look: {}, bag: { ginger: 2 }, carry: null });
  });
});

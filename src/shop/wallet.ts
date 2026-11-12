import { ITEM_KINDS, type ItemKind, type Look } from '../core/types';
import { accessory, cleanLook, isItemKind, ITEM_PRICE, type Slot } from './catalog';

/**
 * The player's coins and purchases, kept on this device (localStorage).
 * Coins are separate from points: earned by playing, never lost to penalties.
 */
export interface ShopData {
  coins: number;
  /** Accessory ids bought. */
  owned: string[];
  /** What is worn now. */
  look: Look;
  /** Shop items in the bag. */
  bag: Partial<Record<ItemKind, number>>;
  /** The item brought into the next game (null: none). */
  carry: ItemKind | null;
}

const KEY = 'dtms.shop.v1';
const MAX_COINS = 999_999;

export function loadShop(): ShopData {
  const empty: ShopData = { coins: 0, owned: [], look: {}, bag: {}, carry: null };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const owned = Array.isArray(v.owned) ? [...new Set(v.owned.filter((id): id is string => typeof id === 'string' && !!accessory(id)))] : [];
    const look = cleanLook(v.look);
    for (const slot of Object.keys(look) as Slot[]) if (!owned.includes(look[slot]!)) delete look[slot];
    const bag: ShopData['bag'] = {};
    if (typeof v.bag === 'object' && v.bag !== null) {
      for (const kind of ITEM_KINDS) {
        const n = (v.bag as Record<string, unknown>)[kind];
        if (typeof n === 'number' && Number.isInteger(n) && n > 0) bag[kind] = Math.min(n, 99);
      }
    }
    const carry = isItemKind(v.carry) && (bag[v.carry] ?? 0) > 0 ? v.carry : null;
    const coins = typeof v.coins === 'number' && Number.isFinite(v.coins) ? Math.max(0, Math.min(MAX_COINS, Math.floor(v.coins))) : 0;
    return { coins, owned, look, bag, carry };
  } catch {
    return empty;
  }
}

export function saveShop(d: ShopData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* private mode: purchases last until the page closes */
  }
}

/**
 * Coins for one finished game: one per 5 points gained, plus a bonus for the
 * top three places.
 */
export function coinsForGame(pointsGained: number, place: number): number {
  const bonus = [10, 5, 2][place - 1] ?? 0;
  return Math.floor(Math.max(0, pointsGained) / 5) + bonus;
}

export function earn(d: ShopData, coins: number): void {
  d.coins = Math.min(MAX_COINS, d.coins + Math.max(0, Math.floor(coins)));
}

/** Buys an accessory. False if already owned or not enough coins. */
export function buyAccessory(d: ShopData, id: string): boolean {
  const a = accessory(id);
  if (!a || d.owned.includes(id) || d.coins < a.price) return false;
  d.coins -= a.price;
  d.owned.push(id);
  d.look[a.slot] = id; // wear it right away
  return true;
}

/** Puts on (or takes off) an owned accessory. */
export function toggleWear(d: ShopData, id: string): void {
  const a = accessory(id);
  if (!a || !d.owned.includes(id)) return;
  if (d.look[a.slot] === id) delete d.look[a.slot];
  else d.look[a.slot] = id;
}

/** Buys one shop item. */
export function buyItem(d: ShopData, kind: ItemKind): boolean {
  const price = ITEM_PRICE[kind];
  if (d.coins < price || (d.bag[kind] ?? 0) >= 99) return false;
  d.coins -= price;
  d.bag[kind] = (d.bag[kind] ?? 0) + 1;
  return true;
}

/** Chooses the item to bring into games (the same again clears it). */
export function toggleCarry(d: ShopData, kind: ItemKind): void {
  if ((d.bag[kind] ?? 0) <= 0) return;
  d.carry = d.carry === kind ? null : kind;
}

/** The item was used in a game: one less in the bag. */
export function itemUsed(d: ShopData, kind: ItemKind): void {
  const left = (d.bag[kind] ?? 0) - 1;
  if (left > 0) d.bag[kind] = left;
  else {
    delete d.bag[kind];
    if (d.carry === kind) d.carry = null;
  }
}

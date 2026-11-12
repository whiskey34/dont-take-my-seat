import { ITEM_KINDS, type ItemKind, type Look } from '../core/types';

/**
 * TokopaEdi, the in-game shop: what can be bought and for how many coins.
 * Pure data (no DOM, no Three.js), so the network code can validate ids too.
 *
 * Accessories are cosmetic only, one per slot. Items are used once in a game
 * (see ItemKind in core/types.ts for what they do).
 */
export type Slot = 'head' | 'body' | 'face' | 'back';
export const SLOTS: readonly Slot[] = ['head', 'body', 'face', 'back'];

export type Model =
  | 'cap'
  | 'bucket'
  | 'beanie'
  | 'peci'
  | 'caping'
  | 'shirt'
  | 'hoodie'
  | 'mask'
  | 'shades'
  | 'glasses'
  | 'backpack'
  | 'sling'
  | 'tote';

export type ColorName =
  | 'red'
  | 'blue'
  | 'black'
  | 'white'
  | 'navy'
  | 'pink'
  | 'purple'
  | 'orange'
  | 'green'
  | 'yellow'
  | 'grey'
  | 'maroon'
  | 'khaki'
  | 'brown'
  | 'cream'
  | 'straw';

export const COLORS: Record<ColorName, string> = {
  red: '#e2453c',
  blue: '#2f7de1',
  black: '#24272c',
  white: '#f2f2ee',
  navy: '#24345a',
  pink: '#f29ac0',
  purple: '#8b5cf6',
  orange: '#f28a2e',
  green: '#3aa864',
  yellow: '#f5c518',
  grey: '#8d949c',
  maroon: '#7d2632',
  khaki: '#c8b48a',
  brown: '#7a5233',
  cream: '#efe3c6',
  straw: '#d8b867',
};

export interface Accessory {
  id: string;
  slot: Slot;
  model: Model;
  color: ColorName;
  price: number;
}

const SLOT_OF: Record<Model, Slot> = {
  cap: 'head',
  bucket: 'head',
  beanie: 'head',
  peci: 'head',
  caping: 'head',
  shirt: 'body',
  hoodie: 'body',
  mask: 'face',
  shades: 'face',
  glasses: 'face',
  backpack: 'back',
  sling: 'back',
  tote: 'back',
};

const PRICE: Record<Model, number> = {
  cap: 40,
  bucket: 50,
  beanie: 45,
  peci: 60,
  caping: 70,
  shirt: 30,
  hoodie: 60,
  mask: 35,
  shades: 50,
  glasses: 45,
  backpack: 50,
  sling: 45,
  tote: 40,
};

const LIST: Array<[Model, ColorName]> = [
  ['cap', 'red'],
  ['cap', 'blue'],
  ['cap', 'black'],
  ['bucket', 'khaki'],
  ['beanie', 'yellow'],
  ['peci', 'black'],
  ['caping', 'straw'],
  ['shirt', 'white'],
  ['shirt', 'black'],
  ['shirt', 'navy'],
  ['shirt', 'pink'],
  ['shirt', 'purple'],
  ['shirt', 'orange'],
  ['shirt', 'green'],
  ['hoodie', 'grey'],
  ['hoodie', 'maroon'],
  ['mask', 'white'],
  ['mask', 'black'],
  ['shades', 'black'],
  ['glasses', 'brown'],
  ['backpack', 'navy'],
  ['backpack', 'red'],
  ['sling', 'brown'],
  ['tote', 'cream'],
];

export const ACCESSORIES: readonly Accessory[] = LIST.map(([model, color]) => ({
  id: `${model}-${color}`,
  slot: SLOT_OF[model],
  model,
  color,
  price: PRICE[model],
}));

const BY_ID = new Map(ACCESSORIES.map((a) => [a.id, a]));
export const accessory = (id: string | undefined): Accessory | undefined => (id ? BY_ID.get(id) : undefined);

export const ITEM_PRICE: Record<ItemKind, number> = {
  jumboPack: 25,
  shoulder: 30,
  runShoes: 20,
  seatBag: 35,
  ginger: 15,
};

export const ITEM_ICON: Record<ItemKind, string> = {
  jumboPack: '🎒',
  shoulder: '💪',
  runShoes: '👟',
  seatBag: '👜',
  ginger: '🍬',
};

/** Keeps only known accessories, each in its own slot (data from the network or storage). */
export function cleanLook(v: unknown): Look {
  const look: Look = {};
  if (typeof v !== 'object' || v === null) return look;
  const r = v as Record<string, unknown>;
  for (const slot of SLOTS) {
    const id = r[slot];
    const a = typeof id === 'string' ? accessory(id) : undefined;
    if (a && a.slot === slot) look[slot] = a.id;
  }
  return look;
}

export const isItemKind = (v: unknown): v is ItemKind => typeof v === 'string' && (ITEM_KINDS as readonly string[]).includes(v);

/** A random outfit for a bot, so the train looks lively (from a bot's own seed). */
export function randomLook(seed: number): Look {
  let x = (seed * 2654435761) >>> 0;
  const next = () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x / 4294967296;
  };
  const look: Look = {};
  for (const slot of SLOTS) {
    if (next() < (slot === 'body' ? 0.6 : 0.35)) continue;
    const options = ACCESSORIES.filter((a) => a.slot === slot);
    const pick = options[Math.floor(next() * options.length)];
    if (pick) look[slot] = pick.id;
  }
  return look;
}

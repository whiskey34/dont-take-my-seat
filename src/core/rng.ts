/**
 * Small seeded PRNG (mulberry32). The state is a plain number stored in the
 * game state, so a game can be replayed or mirrored exactly from its seed.
 */
export function nextRandom(state: number): [value: number, next: number] {
  const next = (state + 0x6d2b79f5) | 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** Picks `count` distinct items from `items` using the game's RNG. */
export function pickDistinct<T>(items: readonly T[], count: number, state: number): [T[], number] {
  const pool = [...items];
  const out: T[] = [];
  let s = state;
  while (out.length < count && pool.length > 0) {
    const [r, n] = nextRandom(s);
    s = n;
    const i = Math.floor(r * pool.length);
    out.push(pool.splice(i, 1)[0] as T);
  }
  return [out, s];
}

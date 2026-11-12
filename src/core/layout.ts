import { CONFIG } from './config';
import type { Seat, Vec2 } from './types';

const { car } = CONFIG;

/** Bench segments along each wall, between the doors. */
export const BENCH_SEGMENTS: ReadonlyArray<readonly [number, number]> = (() => {
  const edges = [-car.halfLength, ...car.doorsX.flatMap((d) => [d - car.doorHalfWidth, d + car.doorHalfWidth]), car.halfLength];
  const segs: Array<readonly [number, number]> = [];
  for (let i = 0; i < edges.length; i += 2) segs.push([edges[i] as number, edges[i + 1] as number]);
  return segs;
})();

/** Builds the seat list. Seats in the end segments are priority seats. */
export function createSeats(): Seat[] {
  const seats: Seat[] = [];
  let id = 0;
  for (const side of [-1, 1] as const) {
    BENCH_SEGMENTS.forEach(([a, b], segIndex) => {
      const count = Math.floor((b - a) / car.seatWidth + 1e-6);
      const start = (a + b) / 2 - ((count - 1) * car.seatWidth) / 2;
      const priority = segIndex === 0 || segIndex === BENCH_SEGMENTS.length - 1;
      for (let i = 0; i < count; i++) {
        seats.push({ id: id++, x: start + i * car.seatWidth, side, priority, npc: true, playerId: null, bagBy: null, bagUntil: 0 });
      }
    });
  }
  return seats;
}

export function seatFront(seat: Seat): Vec2 {
  return { x: seat.x, z: seat.side * car.seatFrontZ };
}

export function seatSitPos(seat: Seat): Vec2 {
  return { x: seat.x, z: seat.side * car.seatZ };
}

export const POLES: ReadonlyArray<Vec2> = car.polesX.map((x) => ({ x, z: 0 }));

export interface Vec2 {
  x: number;
  z: number;
}

export type PlayerId = string;

export interface PlayerInput {
  /** Stick direction, each axis in [-1, 1]. Length is clamped to 1. */
  moveX: number;
  moveZ: number;
  /** True on the single tick the action button was pressed. */
  action: boolean;
}

export const NO_INPUT: PlayerInput = Object.freeze({ moveX: 0, moveZ: 0, action: false });

export interface Player {
  id: PlayerId;
  name: string;
  isBot: boolean;
  colorIndex: number;
  pos: Vec2;
  vel: Vec2;
  facing: number; // radians around the y axis
  seatId: number | null;
  eliminated: boolean;
  eliminatedInRound: number | null;
  stunnedUntil: number;
  pushReadyAt: number;
  kickAt: number | null; // set while sitting on a priority seat
}

export interface Seat {
  id: number;
  x: number;
  side: 1 | -1; // +z wall or -z wall
  priority: boolean;
  npc: boolean; // an NPC passenger is sitting here
  playerId: PlayerId | null;
}

export type Phase = 'intro' | 'riding' | 'scramble' | 'result' | 'gameOver';

export interface GameState {
  time: number;
  phase: Phase;
  phaseEndsAt: number;
  round: number; // 0-based
  station: string;
  players: Player[];
  seats: Seat[];
  /** Seats freed at the current stop (non-priority). */
  freeSeatIds: number[];
  /** A priority seat left open as a trap, or null. */
  trapSeatId: number | null;
  winnerId: PlayerId | null;
  rngState: number;
}

export type GameEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'doorsOpen'; seatIds: number[] }
  | { type: 'sat'; playerId: PlayerId; seatId: number }
  | { type: 'pushed'; by: PlayerId; target: PlayerId }
  | { type: 'kicked'; playerId: PlayerId; seatId: number }
  | { type: 'eliminated'; playerIds: PlayerId[] }
  | { type: 'replay' }
  | { type: 'winner'; playerId: PlayerId };

export interface PlayerSetup {
  id: PlayerId;
  name: string;
  isBot: boolean;
}

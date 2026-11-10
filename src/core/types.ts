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
  shieldUntil: number; // earphones: pushes have no effect until then
  sleeping: boolean; // "pretend to sleep": the next priority seat is kept
  score: number; // points, carried from game to game in one session
  boostUntil: number; // iced coffee: runs faster until then
  slipUntil: number; // slipped on a puddle: sliding, out of control until then
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

/** One random challenge per station. */
export type ChallengeKind = 'suddenBrake' | 'crowd' | 'oneSideDoors' | 'kickFight' | 'puddles';
export const CHALLENGE_KINDS: readonly ChallengeKind[] = ['suddenBrake', 'crowd', 'oneSideDoors', 'kickFight', 'puddles'];

/** A wet patch on the floor: slippery while you stand in it. */
export interface Puddle {
  x: number;
  z: number;
  r: number;
}

export type PointsReason = 'round' | 'win' | 'kick';

export type PowerUpKind = 'earphones' | 'sleep' | 'coffee';
export const POWER_UP_KINDS: readonly PowerUpKind[] = ['earphones', 'sleep', 'coffee'];

/** A standing NPC passenger: an obstacle that drifts around the aisle. */
export interface Stander {
  id: number;
  pos: Vec2;
  target: Vec2;
  moveAt: number;
}

export interface PowerUp {
  id: number;
  kind: PowerUpKind;
  pos: Vec2;
}

export interface GameState {
  time: number;
  phase: Phase;
  phaseEndsAt: number;
  round: number; // 0-based
  station: string;
  /** This game's journey: consecutive real stations, one per stop. */
  route: string[];
  players: Player[];
  seats: Seat[];
  /** Seats freed at the current stop (non-priority). */
  freeSeatIds: number[];
  /** A priority seat left open as a trap, or null. */
  trapSeatId: number | null;
  winnerId: PlayerId | null;
  rngState: number;
  challenge: ChallengeKind | null;
  /** Sudden brake: when it starts, and until when it pulls everyone forward. */
  brakeAt: number | null;
  brakeUntil: number;
  /** Which wall's doors open at this stop: -1 far, 1 near, 0 both. */
  doorSide: -1 | 0 | 1;
  standers: Stander[];
  powerUps: PowerUp[];
  puddles: Puddle[];
  nextId: number;
}

export type GameEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'doorsOpen'; seatIds: number[] }
  | { type: 'sat'; playerId: PlayerId; seatId: number }
  | { type: 'pushed'; by: PlayerId; target: PlayerId }
  | { type: 'kicked'; playerId: PlayerId; seatId: number }
  | { type: 'eliminated'; playerIds: PlayerId[] }
  | { type: 'replay' }
  | { type: 'winner'; playerId: PlayerId }
  | { type: 'challenge'; kind: ChallengeKind }
  | { type: 'suddenBrake' }
  | { type: 'powerUp'; playerId: PlayerId; kind: PowerUpKind }
  | { type: 'shielded'; playerId: PlayerId }
  | { type: 'slept'; playerId: PlayerId; seatId: number }
  | { type: 'seatKick'; by: PlayerId; target: PlayerId; seatId: number }
  | { type: 'slipped'; playerId: PlayerId }
  | { type: 'points'; playerId: PlayerId; amount: number; reason: PointsReason };

export interface PlayerSetup {
  id: PlayerId;
  name: string;
  isBot: boolean;
  /** Points from earlier games in this session. */
  score?: number;
}

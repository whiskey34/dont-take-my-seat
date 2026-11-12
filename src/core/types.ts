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
  /** True on the single tick the shop-item button was pressed. */
  useItem?: boolean;
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
  sickUntil: number; // bad school-lunch tray (MBG): green and slow until then
  slipUntil: number; // slipped on a puddle: sliding, out of control until then
  /** Times caught kicking a seated passenger this game (2nd time: taken off the train). */
  npcStrikes: number;
  /** Accessories (cosmetic only). */
  look: Look;
  /** Shop item brought into this game and not used yet. */
  item: ItemKind | null;
  /** Jumbo backpack ready: the next push is stronger. */
  jumbo: boolean;
  /** Ginger candy: the MBG tray and puddles don't affect you this game. */
  ginger: boolean;
}

/** Mini event: these seats turn into priority seats at `at` (blinking red before). */
export interface SeatMove {
  seatIds: number[];
  at: number;
  warned: boolean;
  done: boolean;
}

export interface Seat {
  id: number;
  x: number;
  side: 1 | -1; // +z wall or -z wall
  priority: boolean;
  npc: boolean; // an NPC passenger is sitting here
  playerId: PlayerId | null;
  /** Seat bag: only this player can sit here until `bagUntil`. */
  bagBy: PlayerId | null;
  bagUntil: number;
}

export type Phase = 'intro' | 'riding' | 'scramble' | 'result' | 'gameOver';

/** One random challenge per station. */
export type ChallengeKind = 'suddenBrake' | 'crowd' | 'oneSideDoors' | 'kickFight' | 'puddles' | 'rushHour';
/** The everyday challenges, one picked at random per stop. */
export const CHALLENGE_KINDS: readonly ChallengeKind[] = ['suddenBrake', 'crowd', 'oneSideDoors', 'kickFight', 'puddles'];
/** Every kind, including the special events (for checking network data). */
export const ALL_CHALLENGES: readonly ChallengeKind[] = [...CHALLENGE_KINDS, 'rushHour'];

/** A wet patch on the floor: slippery while you stand in it. */
export interface Puddle {
  x: number;
  z: number;
  r: number;
}

export type PointsReason = 'round' | 'win' | 'kick' | 'penalty';

export type PowerUpKind = 'earphones' | 'sleep' | 'coffee' | 'mbg';
export const POWER_UP_KINDS: readonly PowerUpKind[] = ['earphones', 'sleep', 'coffee', 'mbg'];

/**
 * Shop items (bought with coins, one brought into a game, used once):
 * - jumboPack: the next push knocks harder and dazes longer (earphones block it)
 * - shoulder: pushes everyone standing close around you at once (earphones block it)
 * - runShoes: a short sprint (puddles still make you slip)
 * - seatBag: leave your bag on the nearest open seat; only you can sit there for a moment
 * - ginger: ginger candy, the stale MBG tray and wet floors can't get you this game
 */
export type ItemKind = 'jumboPack' | 'shoulder' | 'runShoes' | 'seatBag' | 'ginger';
export const ITEM_KINDS: readonly ItemKind[] = ['jumboPack', 'shoulder', 'runShoes', 'seatBag', 'ginger'];

/** Accessory ids per slot (see src/shop/catalog.ts); purely cosmetic. */
export interface Look {
  head?: string;
  body?: string;
  face?: string;
  back?: string;
}

/** A standing NPC passenger: an obstacle that drifts around the aisle. */
export interface Stander {
  id: number;
  pos: Vec2;
  target: Vec2;
  moveAt: number;
  /** A seat hunter: this passenger also races for a seat when the doors open. */
  hunt?: Hunt;
}

export interface Hunt {
  /** Elderly passenger: slower, heads for a priority seat (which is theirs to keep). */
  elder: boolean;
  /** Starts running this long after the doors open (set when they open). */
  startAt: number;
  /** Pushed: dazed until then. */
  stunUntil: number;
  /** Knock-back from a push. */
  vel: Vec2;
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
  /** Mini event "the priority seat moves", if scheduled for this stop. */
  seatMove: SeatMove | null;
  /** Rush hours so far this game (at most 2). */
  rushHours: number;
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
  /** Everyone was taken off the train: the game starts over from the first station. */
  | { type: 'restart'; penalty: number }
  /** A seat-hunting passenger sat down. */
  | { type: 'npcSat'; seatId: number }
  /** A player pushed a seat-hunting passenger. */
  | { type: 'npcPushed'; by: PlayerId }
  /** A player used their shop item. */
  | { type: 'itemUsed'; playerId: PlayerId; kind: ItemKind; seatId?: number }
  | { type: 'winner'; playerId: PlayerId }
  | { type: 'challenge'; kind: ChallengeKind }
  | { type: 'suddenBrake' }
  | { type: 'powerUp'; playerId: PlayerId; kind: PowerUpKind }
  | { type: 'shielded'; playerId: PlayerId }
  | { type: 'slept'; playerId: PlayerId; seatId: number }
  | { type: 'seatKick'; by: PlayerId; target: PlayerId; seatId: number }
  | { type: 'slipped'; playerId: PlayerId }
  | { type: 'npcKick'; playerId: PlayerId; seatId: number; strike: number }
  | { type: 'escorted'; playerId: PlayerId; seatId: number }
  | { type: 'seatMoveWarn'; seatIds: number[] }
  | { type: 'seatMoved'; seatIds: number[] }
  | { type: 'points'; playerId: PlayerId; amount: number; reason: PointsReason };

export interface PlayerSetup {
  id: PlayerId;
  name: string;
  isBot: boolean;
  /** Points from earlier games in this session. */
  score?: number;
  look?: Look;
  /** Shop item brought into the game. */
  item?: ItemKind | null;
}

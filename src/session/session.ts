import { botThink, createBrain, type BotBrain } from '../ai/bot';
import { CONFIG } from '../core/config';
import { createGame, step } from '../core/game';
import type { GameEvent, GameState, PlayerId, PlayerInput, PlayerSetup, Vec2 } from '../core/types';

export const DT = 1 / CONFIG.tickRate;

/** What the app needs from a running game, whoever is simulating it. */
export interface GameSession {
  readonly kind: 'local' | 'host' | 'client';
  readonly humanId: PlayerId | null;
  /** Advances by real elapsed time. `input` is this frame's local input. */
  update(dt: number, input: PlayerInput): GameEvent[];
  /** State to draw this frame, with smoothed positions. */
  view(): GameState;
  /** Players whose device is disconnected right now (multiplayer only). */
  offline?(): ReadonlySet<PlayerId>;
  dispose(): void;
}

export type Difficulty = 'easy' | 'normal';

/**
 * Runs the authoritative simulation at a fixed tick and interpolates
 * positions between ticks for smooth drawing. Used directly for offline
 * games and by the multiplayer host.
 */
export class Simulation {
  readonly state: GameState;
  private readonly brains = new Map<PlayerId, BotBrain>();
  private prev = new Map<PlayerId, Vec2>();
  private acc = 0;

  constructor(setups: readonly PlayerSetup[], seed: number, difficulty: Difficulty) {
    this.state = createGame(setups, seed);
    this.state.players.forEach((p, i) => {
      if (p.isBot) this.brains.set(p.id, createBrain(seed + i * 7919, difficulty));
    });
    this.snapshotPrev();
  }

  /**
   * Runs as many fixed ticks as `dt` covers. `inputFor` supplies non-bot
   * input for each tick; `first` is true only on the first tick of this call
   * so one-shot actions are applied once.
   */
  advance(dt: number, inputFor: (id: PlayerId, first: boolean) => PlayerInput): GameEvent[] {
    const events: GameEvent[] = [];
    this.acc = Math.min(this.acc + dt, DT * 15); // catch up after slow frames (up to 0.25 s)
    let first = true;
    while (this.acc >= DT) {
      this.snapshotPrev();
      const inputs = new Map<PlayerId, PlayerInput>();
      for (const p of this.state.players) {
        const brain = this.brains.get(p.id);
        inputs.set(p.id, p.isBot && brain ? botThink(this.state, p, brain, DT) : inputFor(p.id, first));
      }
      events.push(...step(this.state, inputs, DT));
      this.acc -= DT;
      first = false;
    }
    return events;
  }

  /** True when no tick ran yet this frame (so a one-shot action must wait). */
  get pendingTick(): boolean {
    return this.acc < DT;
  }

  /** Current state with positions interpolated between the last two ticks. */
  view(): GameState {
    const alpha = this.acc / DT;
    return withPositions(this.state, (p) => {
      const a = this.prev.get(p.id);
      if (!a || p.seatId !== null) return p.pos;
      // Large jumps (sitting down, being kicked) should not be smeared.
      if (Math.hypot(p.pos.x - a.x, p.pos.z - a.z) > 1) return p.pos;
      return { x: a.x + (p.pos.x - a.x) * alpha, z: a.z + (p.pos.z - a.z) * alpha };
    });
  }

  private snapshotPrev(): void {
    this.prev = new Map(this.state.players.map((p) => [p.id, { ...p.pos }]));
  }
}

/** Shallow copy of a state with new player positions (for drawing only). */
export function withPositions(s: GameState, pos: (p: GameState['players'][number]) => Vec2): GameState {
  return { ...s, players: s.players.map((p) => ({ ...p, pos: pos(p) })) };
}

/** Offline game: one human against bots, or bots only (menu backdrop). */
export class LocalSession implements GameSession {
  readonly kind = 'local';
  private readonly sim: Simulation;
  private pendingAction = false;

  constructor(
    setups: readonly PlayerSetup[],
    seed: number,
    difficulty: Difficulty,
    readonly humanId: PlayerId | null,
  ) {
    this.sim = new Simulation(setups, seed, difficulty);
  }

  get state(): GameState {
    return this.sim.state;
  }

  update(dt: number, input: PlayerInput): GameEvent[] {
    this.pendingAction ||= input.action;
    return this.sim.advance(dt, (id, first) => {
      if (id !== this.humanId) return { moveX: 0, moveZ: 0, action: false };
      const action = first && this.pendingAction;
      if (action) this.pendingAction = false;
      return { moveX: input.moveX, moveZ: input.moveZ, action };
    });
  }

  view(): GameState {
    return this.sim.view();
  }

  dispose(): void {}
}

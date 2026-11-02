import type { GameEvent, GameState, Phase, Player, PlayerSetup, Seat } from '../core/types';

/** Bump when messages change incompatibly; peers with another version are refused. */
export const PROTOCOL_VERSION = 1;
export const MAX_NAME = 14;

export interface LobbyPlayer {
  id: string;
  name: string;
}

// --------------------------------------------------------------- messages

export type ClientMsg =
  | { t: 'hello'; v: number; name: string }
  | { t: 'in'; s: number; x: number; z: number }
  | { t: 'act'; s: number }
  | { t: 'bye' };

export type HostMsg =
  | { t: 'welcome'; v: number; id: string }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'lobby'; players: LobbyPlayer[] }
  | { t: 'start'; seed: number; players: PlayerSetup[]; difficulty: 'easy' | 'normal' }
  | { t: 'snap'; s: Snapshot }
  | { t: 'ev'; e: GameEvent[] }
  | { t: 'bye'; reason: 'left' | 'closed' };

export type RejectReason = 'full' | 'started' | 'version';

// --------------------------------------------------------------- snapshot

/** Compact copy of everything that changes during play. */
export interface Snapshot {
  time: number;
  phase: Phase;
  end: number; // phaseEndsAt, -1 for Infinity
  round: number;
  station: string;
  free: number[];
  trap: number;
  winner: string;
  /** [id, x, z, vx, vz, facing, seat, eliminated, elimRound, stunnedUntil, pushReadyAt, kickAt] */
  p: Array<[string, number, number, number, number, number, number, 0 | 1, number, number, number, number]>;
  /** One char per seat: '0' empty, '1' NPC. */
  npc: string;
  /** [seatId, playerId] for occupied seats. */
  occ: Array<[number, string]>;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function packSnapshot(s: GameState): Snapshot {
  return {
    time: r3(s.time),
    phase: s.phase,
    end: Number.isFinite(s.phaseEndsAt) ? r3(s.phaseEndsAt) : -1,
    round: s.round,
    station: s.station,
    free: [...s.freeSeatIds],
    trap: s.trapSeatId ?? -1,
    winner: s.winnerId ?? '',
    p: s.players.map((p) => [
      p.id,
      r3(p.pos.x),
      r3(p.pos.z),
      r3(p.vel.x),
      r3(p.vel.z),
      r3(p.facing),
      p.seatId ?? -1,
      p.eliminated ? 1 : 0,
      p.eliminatedInRound ?? -1,
      r3(p.stunnedUntil),
      r3(p.pushReadyAt),
      p.kickAt === null ? -1 : r3(p.kickAt),
    ]),
    npc: s.seats.map((x) => (x.npc ? '1' : '0')).join(''),
    occ: s.seats.filter((x) => x.playerId !== null).map((x) => [x.id, x.playerId as string]),
  };
}

/** Writes a snapshot into an existing state (which owns names, colours, seats layout). */
export function applySnapshot(s: GameState, snap: Snapshot): void {
  s.time = snap.time;
  s.phase = snap.phase;
  s.phaseEndsAt = snap.end < 0 ? Infinity : snap.end;
  s.round = snap.round;
  s.station = snap.station;
  s.freeSeatIds = snap.free.filter((id) => id >= 0 && id < s.seats.length);
  s.trapSeatId = snap.trap >= 0 ? snap.trap : null;
  s.winnerId = snap.winner || null;
  for (const row of snap.p) {
    const p = s.players.find((q) => q.id === row[0]);
    if (!p) continue;
    applyPlayerRow(p, row);
  }
  s.seats.forEach((seat: Seat, i) => {
    seat.npc = snap.npc[i] === '1';
    seat.playerId = null;
  });
  for (const [id, pid] of snap.occ) {
    const seat = s.seats[id];
    if (seat) seat.playerId = pid;
  }
}

export function applyPlayerRow(p: Player, row: Snapshot['p'][number]): void {
  p.pos = { x: row[1], z: row[2] };
  p.vel = { x: row[3], z: row[4] };
  p.facing = row[5];
  p.seatId = row[6] >= 0 ? row[6] : null;
  p.eliminated = row[7] === 1;
  p.eliminatedInRound = row[8] >= 0 ? row[8] : null;
  p.stunnedUntil = row[9];
  p.pushReadyAt = row[10];
  p.kickAt = row[11] >= 0 ? row[11] : null;
}

// --------------------------------------------------------------- validation

const PHASES: readonly Phase[] = ['intro', 'riding', 'scramble', 'result', 'gameOver'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const isInt = (v: unknown): v is number => Number.isInteger(v);

export function cleanName(name: unknown): string {
  const s = typeof name === 'string' ? name : '';
  // Strip control characters and trim to a short display name.
  const cleaned = s.replace(/[\p{C}]/gu, '').trim().slice(0, MAX_NAME);
  return cleaned || 'Player';
}

function parse(data: string): unknown {
  if (data.length > 64_000) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Parses a message from a client. Anything malformed returns null. */
export function parseClientMsg(data: string): ClientMsg | null {
  const m = parse(data);
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'hello':
      return isInt(m.v) ? { t: 'hello', v: m.v, name: cleanName(m.name) } : null;
    case 'in':
      if (!isInt(m.s) || !isNum(m.x) || !isNum(m.z)) return null;
      return { t: 'in', s: m.s, x: Math.max(-1, Math.min(1, m.x)), z: Math.max(-1, Math.min(1, m.z)) };
    case 'act':
      return isInt(m.s) ? { t: 'act', s: m.s } : null;
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

/** Parses a message from the host. Anything malformed returns null. */
export function parseHostMsg(data: string): HostMsg | null {
  const m = parse(data);
  if (!isObj(m)) return null;
  switch (m.t) {
    case 'welcome':
      return isInt(m.v) && isStr(m.id) ? { t: 'welcome', v: m.v, id: m.id } : null;
    case 'reject':
      return m.reason === 'full' || m.reason === 'started' || m.reason === 'version' ? { t: 'reject', reason: m.reason } : null;
    case 'lobby':
      if (!Array.isArray(m.players) || m.players.length > 4) return null;
      if (!m.players.every((p) => isObj(p) && isStr(p.id))) return null;
      return { t: 'lobby', players: m.players.map((p) => ({ id: String(p.id), name: cleanName(p.name) })) };
    case 'start': {
      if (!isInt(m.seed) || !Array.isArray(m.players) || m.players.length < 2 || m.players.length > 4) return null;
      if (!m.players.every((p) => isObj(p) && isStr(p.id) && typeof p.isBot === 'boolean')) return null;
      const players = (m.players as Array<Record<string, unknown>>).map((p) => ({ id: String(p.id), name: cleanName(p.name), isBot: p.isBot === true }));
      return { t: 'start', seed: m.seed, players, difficulty: m.difficulty === 'easy' ? 'easy' : 'normal' };
    }
    case 'snap':
      return isSnapshot(m.s) ? { t: 'snap', s: m.s } : null;
    case 'ev':
      return Array.isArray(m.e) && m.e.every(isEvent) ? { t: 'ev', e: m.e } : null;
    case 'bye':
      return { t: 'bye', reason: m.reason === 'closed' ? 'closed' : 'left' };
    default:
      return null;
  }
}

function isSnapshot(v: unknown): v is Snapshot {
  if (!isObj(v)) return false;
  if (!isNum(v.time) || !PHASES.includes(v.phase as Phase) || !isNum(v.end) || !isInt(v.round) || !isStr(v.station)) return false;
  if (!Array.isArray(v.free) || !v.free.every(isInt) || !isInt(v.trap) || !isStr(v.winner)) return false;
  if (typeof v.npc !== 'string' || v.npc.length > 200 || !Array.isArray(v.occ) || !Array.isArray(v.p) || v.p.length > 4) return false;
  if (!v.occ.every((o) => Array.isArray(o) && o.length === 2 && isInt(o[0]) && isStr(o[1]))) return false;
  return v.p.every((row) => Array.isArray(row) && row.length === 12 && isStr(row[0]) && row.slice(1).every(isNum));
}

function isEvent(e: unknown): e is GameEvent {
  if (!isObj(e) || typeof e.type !== 'string') return false;
  switch (e.type) {
    case 'phase':
      return PHASES.includes(e.phase as Phase);
    case 'doorsOpen':
      return Array.isArray(e.seatIds) && e.seatIds.every(isInt);
    case 'sat':
    case 'kicked':
      return isStr(e.playerId) && isInt(e.seatId);
    case 'pushed':
      return isStr(e.by) && isStr(e.target);
    case 'eliminated':
      return Array.isArray(e.playerIds) && e.playerIds.every((x) => isStr(x));
    case 'replay':
      return true;
    case 'winner':
      return isStr(e.playerId);
    default:
      return false;
  }
}

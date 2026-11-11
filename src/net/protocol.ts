import { ALL_CHALLENGES, POWER_UP_KINDS, type ChallengeKind, type GameEvent, type GameState, type Phase, type Player, type PlayerSetup, type PowerUpKind, type Seat } from '../core/types';

/** Bump when messages change incompatibly; peers with another version are refused. */
export const PROTOCOL_VERSION = 11;
export const MAX_NAME = 14;

export interface LobbyPlayer {
  id: string;
  name: string;
}

// --------------------------------------------------------------- messages

export type ClientMsg =
  /** `k` is this device's player key; the same key can rejoin a game in progress. */
  | { t: 'hello'; v: number; name: string; k: string }
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
  /** `next`: when the host closes the room, the player id who takes over as host. */
  | { t: 'bye'; reason: 'left' | 'closed'; next?: string };

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
  /** [id, x, z, vx, vz, facing, seat, eliminated, elimRound, stunnedUntil, pushReadyAt, kickAt, shieldUntil, sleeping, score, boostUntil, slipUntil, npcStrikes, sickUntil] */
  p: Array<[string, number, number, number, number, number, number, 0 | 1, number, number, number, number, number, 0 | 1, number, number, number, number, number]>;
  /** Puddles [x, z, r] (wet floor challenge). */
  pd: Array<[number, number, number]>;
  /** Challenge of this stop ('' none), sudden-brake end time, open door side. */
  ch: ChallengeKind | '';
  bk: number;
  ds: -1 | 0 | 1;
  /** Players whose device is disconnected right now (their character stands still). */
  off: string[];
  /** [playerId, last movement input seq the host has applied] for client reconciliation. */
  ack: Array<[string, number]>;
  /** Standing passengers [id, x, z] and power-ups [id, kind, x, z]. */
  st: Array<[number, number, number]>;
  pu: Array<[number, PowerUpKind, number, number]>;
  /** One char per seat: '0' empty, '1' NPC. */
  npc: string;
  /** [seatId, playerId] for occupied seats. */
  occ: Array<[number, string]>;
  /** One char per seat: '1' priority seat (they can move during a stop). */
  pr: string;
  /** Moving priority seat: [time it happens, warned, done, ...seatIds], or [] when none. */
  sm: number[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function packSnapshot(s: GameState, offline: Iterable<string> = [], acks: Iterable<[string, number]> = []): Snapshot {
  return {
    off: [...offline],
    ack: [...acks],
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
      r3(p.shieldUntil),
      p.sleeping ? 1 : 0,
      p.score,
      r3(p.boostUntil),
      r3(p.slipUntil),
      p.npcStrikes,
      r3(p.sickUntil),
    ]),
    pd: s.puddles.map((d) => [r3(d.x), r3(d.z), r3(d.r)]),
    ch: s.challenge ?? '',
    bk: r3(s.brakeUntil),
    ds: s.doorSide,
    st: s.standers.map((x) => [x.id, r3(x.pos.x), r3(x.pos.z)]),
    pu: s.powerUps.map((u) => [u.id, u.kind, r3(u.pos.x), r3(u.pos.z)]),
    npc: s.seats.map((x) => (x.npc ? '1' : '0')).join(''),
    occ: s.seats.filter((x) => x.playerId !== null).map((x) => [x.id, x.playerId as string]),
    pr: s.seats.map((x) => (x.priority ? '1' : '0')).join(''),
    sm: s.seatMove ? [r3(s.seatMove.at), s.seatMove.warned ? 1 : 0, s.seatMove.done ? 1 : 0, ...s.seatMove.seatIds] : [],
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
    seat.priority = snap.pr[i] === '1';
    seat.playerId = null;
  });
  for (const [id, pid] of snap.occ) {
    const seat = s.seats[id];
    if (seat) seat.playerId = pid;
  }
  s.challenge = snap.ch || null;
  s.brakeUntil = snap.bk;
  s.doorSide = snap.ds;
  // Standers only need a position on clients; their next move comes from the host.
  s.standers = snap.st.map(([id, x, z]) => ({ id, pos: { x, z }, target: { x, z }, moveAt: Infinity }));
  s.powerUps = snap.pu.map(([id, kind, x, z]) => ({ id, kind, pos: { x, z } }));
  s.puddles = snap.pd.map(([x, z, r]) => ({ x, z, r }));
  const [at, warned, done, ...ids] = snap.sm;
  s.seatMove = at === undefined ? null : { at, warned: warned === 1, done: done === 1, seatIds: ids.filter((id) => id >= 0 && id < s.seats.length) };
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
  p.shieldUntil = row[12];
  p.sleeping = row[13] === 1;
  p.score = row[14];
  p.boostUntil = row[15];
  p.slipUntil = row[16];
  p.npcStrikes = row[17];
  p.sickUntil = row[18];
}

// --------------------------------------------------------------- validation

const PHASES: readonly Phase[] = ['intro', 'riding', 'scramble', 'result', 'gameOver'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const isInt = (v: unknown): v is number => Number.isInteger(v);

/** Player keys are random ids made on the device; anything else counts as "no key". */
export function cleanKey(k: unknown): string {
  return typeof k === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(k) ? k : '';
}

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
      return isInt(m.v) ? { t: 'hello', v: m.v, name: cleanName(m.name), k: cleanKey(m.k) } : null;
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
      const players = (m.players as Array<Record<string, unknown>>).map((p) => ({
        id: String(p.id),
        name: cleanName(p.name),
        isBot: p.isBot === true,
        score: isInt(p.score) && p.score >= 0 ? p.score : 0,
      }));
      return { t: 'start', seed: m.seed, players, difficulty: m.difficulty === 'easy' ? 'easy' : 'normal' };
    }
    case 'snap':
      return isSnapshot(m.s) ? { t: 'snap', s: m.s } : null;
    case 'ev':
      return Array.isArray(m.e) && m.e.every(isEvent) ? { t: 'ev', e: m.e } : null;
    case 'bye':
      if (m.reason !== 'closed') return { t: 'bye', reason: 'left' };
      return isStr(m.next) && m.next ? { t: 'bye', reason: 'closed', next: m.next } : { t: 'bye', reason: 'closed' };
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
  if (!v.p.every((row) => Array.isArray(row) && row.length === 19 && isStr(row[0]) && row.slice(1).every(isNum))) return false;
  if (v.ch !== '' && !ALL_CHALLENGES.includes(v.ch as ChallengeKind)) return false;
  if (!isNum(v.bk) || (v.ds !== -1 && v.ds !== 0 && v.ds !== 1)) return false;
  if (!Array.isArray(v.st) || v.st.length > 30 || !v.st.every((r) => Array.isArray(r) && r.length === 3 && r.every(isNum))) return false;
  if (!Array.isArray(v.off) || v.off.length > 4 || !v.off.every((x) => isStr(x))) return false;
  if (!Array.isArray(v.pd) || v.pd.length > 8 || !v.pd.every((r) => Array.isArray(r) && r.length === 3 && r.every(isNum))) return false;
  if (typeof v.pr !== 'string' || v.pr.length > 200) return false;
  if (!Array.isArray(v.sm) || v.sm.length > 6 || !v.sm.every(isNum) || !v.sm.slice(1).every(isInt)) return false;
  if (!Array.isArray(v.ack) || v.ack.length > 4 || !v.ack.every((a) => Array.isArray(a) && a.length === 2 && isStr(a[0]) && isInt(a[1]))) return false;
  return (
    Array.isArray(v.pu) &&
    v.pu.length <= 4 &&
    v.pu.every((r) => Array.isArray(r) && r.length === 4 && isInt(r[0]) && POWER_UP_KINDS.includes(r[1] as PowerUpKind) && isNum(r[2]) && isNum(r[3]))
  );
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
    case 'slipped':
      return isStr(e.playerId);
    case 'seatKick':
      return isStr(e.by) && isStr(e.target) && isInt(e.seatId);
    case 'points':
      return isStr(e.playerId) && isInt(e.amount) && (e.reason === 'round' || e.reason === 'win' || e.reason === 'kick' || e.reason === 'penalty');
    case 'eliminated':
      return Array.isArray(e.playerIds) && e.playerIds.every((x) => isStr(x));
    case 'replay':
      return true;
    case 'restart':
      return isInt(e.penalty);
    case 'winner':
    case 'shielded':
      return isStr(e.playerId);
    case 'challenge':
      return ALL_CHALLENGES.includes(e.kind as ChallengeKind);
    case 'suddenBrake':
      return true;
    case 'powerUp':
      return isStr(e.playerId) && POWER_UP_KINDS.includes(e.kind as PowerUpKind);
    case 'slept':
    case 'escorted':
      return isStr(e.playerId) && isInt(e.seatId);
    case 'npcKick':
      return isStr(e.playerId) && isInt(e.seatId) && isInt(e.strike);
    case 'seatMoveWarn':
    case 'seatMoved':
      return Array.isArray(e.seatIds) && e.seatIds.length <= 4 && e.seatIds.every(isInt);
    default:
      return false;
  }
}

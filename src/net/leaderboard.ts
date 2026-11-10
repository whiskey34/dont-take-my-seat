import { SIGNAL_URL } from './config';

/** The shared leaderboard on the Cloudflare Worker (best points per device). */
export interface BoardRow {
  name: string;
  score: number;
  wins: number;
}

export interface Board {
  top: BoardRow[];
  me: (BoardRow & { rank: number }) | null;
  total: number;
}

/** False when the game was built without the Worker (then there is no leaderboard). */
export const hasLeaderboard = (): boolean => !!SIGNAL_URL;

function valid(v: unknown): v is Board {
  const b = v as Board;
  return !!b && Array.isArray(b.top) && typeof b.total === 'number';
}

async function call(init?: RequestInit, key?: string): Promise<Board | null> {
  if (!SIGNAL_URL) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const q = key && !init ? `?key=${encodeURIComponent(key)}` : '';
    const res = await fetch(`${SIGNAL_URL}/scores${q}`, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    const v: unknown = await res.json();
    return valid(v) ? v : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchBoard(key: string): Promise<Board | null> {
  return call(undefined, key);
}

/** Reports this device's points after a game; returns the updated board. */
export function reportScore(key: string, name: string, score: number, won: boolean): Promise<Board | null> {
  return call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, name, score, won }) });
}

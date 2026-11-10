import { SIGNAL_URL } from '../config';

/**
 * ICE servers for WebRTC. With the Cloudflare Worker configured, it hands out
 * short-lived Cloudflare TURN credentials (TURN on ports 443 and 80), which
 * get phones connected even when carriers block direct connections.
 * Without it (or if it fails), public STUN only.
 */
const STUN_ONLY: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let cache: { servers: RTCIceServer[]; until: number; turn: boolean } | null = null;
let pending: Promise<RTCIceServer[]> | null = null;

export function hasTurn(): boolean {
  return !!cache?.turn && cache.until > Date.now();
}

export function getIceServers(base: string = SIGNAL_URL): Promise<RTCIceServer[]> {
  if (!base) return Promise.resolve(STUN_ONLY);
  if (cache && cache.until > Date.now()) return Promise.resolve(cache.servers);
  pending ??= (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${base}/turn`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { iceServers?: RTCIceServer[]; ttl?: number; turn?: boolean };
      if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) throw new Error('empty');
      // Refresh well before the credentials expire.
      const ttl = Math.max(60, Math.min(Number(data.ttl) || 3600, 4 * 3600));
      cache = { servers: data.iceServers, until: Date.now() + (ttl * 1000) / 2, turn: data.turn === true };
      return data.iceServers;
    } catch {
      cache = { servers: STUN_ONLY, until: Date.now() + 60_000, turn: false };
      return STUN_ONLY;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

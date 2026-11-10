/**
 * Don't Take My Seat: signaling + TURN credentials on Cloudflare.
 *
 *   GET /room/<topic>   WebSocket. Everyone with the same room code meets in
 *                       one Durable Object; each text message is passed on to
 *                       everyone else in the room. Messages are already
 *                       encrypted with the room code, so this server never
 *                       sees game data or connection details in the clear.
 *   GET /turn           Short-lived Cloudflare TURN credentials (ports 443,
 *                       80, 3478, 5349), so phones on networks that block
 *                       direct connections can still play.
 *   GET /               Health check.
 */

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Comma-separated list of web origins allowed to use this Worker. */
  ALLOWED_ORIGINS: string;
  /** From the Cloudflare dashboard (Realtime → TURN). Set as secrets. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const TOPIC = /^dtms\/v1\/[0-9a-f]{24}$/;
const MAX_MESSAGE = 16_000;
const MAX_PEERS = 16;
const TURN_TTL_S = 4 * 60 * 60; // longer than any game session
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get('Origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function cors(origin: string | null): Record<string, string> {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET', Vary: 'Origin' } : { Vary: 'Origin' };
}

/** Cached per isolate, so many players share one call to the TURN API. */
let turnCache: { body: string; until: number } | null = null;

async function turnCredentials(env: Env): Promise<string> {
  const now = Date.now();
  if (turnCache && turnCache.until > now) return turnCache.body;
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return JSON.stringify({ iceServers: FALLBACK_ICE, ttl: 3600, turn: false });
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TURN_TTL_S }),
  });
  if (!res.ok) return JSON.stringify({ iceServers: FALLBACK_ICE, ttl: 300, turn: false, error: `turn api ${res.status}` });
  const data = (await res.json()) as { iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> };
  // Browsers block port 53, and without trickle ICE a dead URL only adds delay.
  const iceServers = data.iceServers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
  const body = JSON.stringify({ iceServers, ttl: TURN_TTL_S, turn: true });
  // Hand out the same credentials for a while; they stay valid much longer.
  turnCache = { body, until: now + 30 * 60 * 1000 };
  return body;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = allowedOrigin(req, env);

    if (url.pathname === '/') return new Response('dtms-signal ok', { headers: { 'Content-Type': 'text/plain' } });

    if (url.pathname === '/turn') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
      if (!origin) return new Response('origin not allowed', { status: 403, headers: cors(null) });
      const body = await turnCredentials(env);
      return new Response(body, { headers: { ...cors(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname.startsWith('/room/')) {
      const topic = decodeURIComponent(url.pathname.slice('/room/'.length));
      if (!TOPIC.test(topic)) return new Response('bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      // Checked here so rejected requests never reach (or bill) the Durable Object.
      if (!origin) return new Response('origin not allowed', { status: 403 });
      return env.ROOMS.get(env.ROOMS.idFromName(topic)).fetch(req);
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * One room code = one Durable Object. Uses the WebSocket Hibernation API, so
 * an idle lobby costs nothing while players are connected.
 */
export class Room extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    if (this.ctx.getWebSockets().length >= MAX_PEERS) return new Response('room full', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(message);
      } catch {
        /* closing */
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* already closed */
    }
  }
}

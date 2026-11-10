import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerRoomUrl } from '../src/net/config';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Cloudflare Worker config', () => {
  it('builds the room WebSocket URL', () => {
    expect(workerRoomUrl('https://dtms-signal.x.workers.dev', 'dtms/v1/abc')).toBe('wss://dtms-signal.x.workers.dev/room/dtms%2Fv1%2Fabc');
    expect(workerRoomUrl('http://localhost:8787', 't')).toBe('ws://localhost:8787/room/t');
  });

  it('uses TURN from the Worker and caches it', async () => {
    const turn = [{ urls: ['turn:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ iceServers: turn, ttl: 3600, turn: true })));
    vi.stubGlobal('fetch', fetchMock);
    const { getIceServers, hasTurn } = await import('../src/net/rtc/ice');
    expect(await getIceServers('https://w.example')).toEqual(turn);
    expect(await getIceServers('https://w.example')).toEqual(turn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hasTurn()).toBe(true);
  });

  it('falls back to STUN when the Worker is unreachable or not configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const { getIceServers, hasTurn } = await import('../src/net/rtc/ice');
    const servers = await getIceServers('https://w.example');
    expect(JSON.stringify(servers)).toContain('stun:');
    expect(JSON.stringify(servers)).not.toContain('turn:');
    expect(hasTurn()).toBe(false);
    expect(JSON.stringify(await getIceServers(''))).toContain('stun:');
  });
});

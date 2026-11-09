import { describe, expect, it } from 'vitest';
import { BROKERS } from '../src/net/signal/mqtt';
import { NOSTR_RELAYS } from '../src/net/signal/nostr';
import { RoomSignaling } from '../src/net/signal/roomSignaling';
import { newRoomCode, type SignalMsg } from '../src/net/signal/signal';

// Talks to the real public relays, so it only runs when asked:
//   LIVE_BROKERS=1 npx vitest run tests/brokers.live.test.ts
const live = !!process.env.LIVE_BROKERS;

const relays = [
  ...BROKERS.map((url) => ({ url, list: { mqtt: [url], nostr: [] } })),
  ...NOSTR_RELAYS.map((url) => ({ url, list: { mqtt: [], nostr: [url] } })),
  // Candidates under evaluation; promote to the lists above once green.
  ...(process.env.EXTRA_NOSTR ?? '').split(',').filter(Boolean).map((url) => ({ url, list: { mqtt: [], nostr: [url] } })),
];

describe.skipIf(!live)('public signaling relays (live)', () => {
  for (const { url, list } of relays) {
    it(`relays an encrypted signal through ${url}`, async () => {
      const code = newRoomCode();
      const a = new RoomSignaling(code, list);
      const b = new RoomSignaling(code, list);
      try {
        await Promise.all([a.ready, b.ready]);
        const got = new Promise<SignalMsg>((resolve) => b.onMessage(resolve));
        // Repeat like the game does, in case the first one races the subscription.
        const t = setInterval(() => a.publish({ type: 'hello', from: 'live-test' }), 1000);
        a.publish({ type: 'hello', from: 'live-test' });
        const msg = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no message within 10s')), 10000))]).finally(() => clearInterval(t));
        expect(msg).toEqual({ type: 'hello', from: 'live-test' });
      } finally {
        a.close();
        b.close();
      }
    }, 25_000);
  }
});

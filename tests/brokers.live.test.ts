import { describe, expect, it } from 'vitest';
import { BROKERS, MqttSignaling } from '../src/net/signal/mqtt';
import { newRoomCode, type SignalMsg } from '../src/net/signal/signal';

// Talks to the real public brokers, so it only runs when asked:
//   LIVE_BROKERS=1 npx vitest run tests/brokers.live.test.ts
const live = !!process.env.LIVE_BROKERS;

describe.skipIf(!live)('public MQTT brokers (live)', () => {
  for (const url of BROKERS) {
    it(`relays an encrypted signal through ${url}`, async () => {
      const code = newRoomCode();
      const a = new MqttSignaling(code, [url]);
      const b = new MqttSignaling(code, [url]);
      try {
        await Promise.all([a.ready, b.ready]);
        const got = new Promise<SignalMsg>((resolve) => b.onMessage(resolve));
        a.publish({ type: 'hello', from: 'live-test' });
        const msg = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no message within 8s')), 8000))]);
        expect(msg).toEqual({ type: 'hello', from: 'live-test' });
      } finally {
        a.close();
        b.close();
      }
    }, 20_000);
  }
});

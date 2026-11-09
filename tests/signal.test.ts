import { describe, expect, it } from 'vitest';
import { open, roomKeys, seal } from '../src/net/signal/crypto';
import { connectPacket, publishPacket, readPackets, readPublish, subscribePacket } from '../src/net/signal/mqtt';
import { CODE_ALPHABET, newRoomCode, normalizeCode, parseSignal } from '../src/net/signal/signal';

describe('room codes', () => {
  it('generates and normalizes codes', () => {
    const code = newRoomCode();
    expect(code).toHaveLength(5);
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    expect(normalizeCode(' ab-cd7 ')).toBe('ABCD7');
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode('ABCD0')).toBeNull(); // 0 is not used in codes
  });
});

describe('mqtt codec', () => {
  it('encodes CONNECT and SUBSCRIBE per MQTT 3.1.1', () => {
    const c = connectPacket('id');
    expect([...c.subarray(0, 2)]).toEqual([0x10, c.length - 2]);
    expect(new TextDecoder().decode(c.subarray(4, 8))).toBe('MQTT');
    expect(c[8]).toBe(4); // protocol level
    expect([...subscribePacket(1, 't')]).toEqual([0x82, 6, 0, 1, 0, 1, 116, 0]);
  });

  it('splits a stream into packets, including long and partial ones', () => {
    const big = publishPacket('room/x', new Uint8Array(300).fill(7));
    const small = publishPacket('room/x', new Uint8Array([1, 2, 3]));
    const stream = new Uint8Array([...big, ...small, ...small.subarray(0, 3)]);
    const [packets, rest] = readPackets(stream);
    expect(packets).toHaveLength(2);
    expect(rest).toHaveLength(3);
    const p = readPublish(packets[0]!);
    expect(p.topic).toBe('room/x');
    expect(p.payload).toHaveLength(300);
    expect([...readPublish(packets[1]!).payload]).toEqual([1, 2, 3]);
  });
});

describe('room encryption', () => {
  it('only the same room code can read a message', async () => {
    const a = await roomKeys('ABCDE');
    const b = await roomKeys('ABCDE');
    const other = await roomKeys('ZZZZZ');
    expect(a.topic).toBe(b.topic);
    expect(a.topic).not.toBe(other.topic);
    expect(a.topic).not.toContain('ABCDE');
    const sealed = await seal(a.key, { hello: 'world' });
    expect(await open(b.key, sealed)).toEqual({ hello: 'world' });
    expect(await open(other.key, sealed)).toBeNull();
    sealed[20] = sealed[20]! ^ 1;
    expect(await open(b.key, sealed)).toBeNull();
  });

  it('validates signaling messages', () => {
    expect(parseSignal({ type: 'hello', from: 'p1' })).toEqual({ type: 'hello', from: 'p1' });
    expect(parseSignal({ type: 'offer', from: 'h', to: 'p', sdp: 'x'.repeat(30_000) })).toBeNull();
    expect(parseSignal({ type: 'other', from: 'h' })).toBeNull();
    expect(parseSignal(null)).toBeNull();
  });
});

import { parseSignal, type SignalMsg, type Signaling } from './signal';

/**
 * Room-code signaling over free public MQTT brokers (WebSocket).
 *
 * - No server of our own: peers meet on a topic derived from the room code.
 * - Messages are encrypted with a key derived from the room code, so the
 *   broker (and anyone without the code) cannot read connection details.
 * - Two brokers are used at once; if one is down the other still works.
 *   Duplicates are dropped by message id.
 */
// Verified by the live broker check in CI (tests/brokers.live.test.ts).
export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const CONNECT_TIMEOUT_MS = 6000;
const KEEPALIVE_S = 30;

// ------------------------------------------------------------------ codec

const enc = new TextEncoder();
const dec = new TextDecoder();

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function str(s: string): number[] {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(type: number, body: number[] | Uint8Array): Uint8Array {
  const head = [type, ...remainingLength(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export function connectPacket(clientId: string): Uint8Array {
  return packet(0x10, [...str('MQTT'), 4, 0x02, 0, KEEPALIVE_S, ...str(clientId)]);
}

export function subscribePacket(packetId: number, topic: string): Uint8Array {
  return packet(0x82, [packetId >> 8, packetId & 0xff, ...str(topic), 0]);
}

export function publishPacket(topic: string, payload: Uint8Array): Uint8Array {
  const t = str(topic);
  const body = new Uint8Array(t.length + payload.length);
  body.set(t, 0);
  body.set(payload, t.length);
  return packet(0x30, body);
}

export const PINGREQ = new Uint8Array([0xc0, 0x00]);

export interface MqttPacket {
  type: number; // high nibble
  flags: number;
  body: Uint8Array;
}

/** Splits a byte stream into packets; returns packets and leftover bytes. */
export function readPackets(buf: Uint8Array): [MqttPacket[], Uint8Array] {
  const out: MqttPacket[] = [];
  let i = 0;
  while (i < buf.length) {
    let len = 0;
    let mul = 1;
    let j = i + 1;
    let complete = false;
    for (let k = 0; k < 4 && j < buf.length; k++, j++) {
      const b = buf[j]!;
      len += (b & 0x7f) * mul;
      mul *= 128;
      if ((b & 0x80) === 0) {
        complete = true;
        j++;
        break;
      }
    }
    if (!complete || j + len > buf.length) break;
    out.push({ type: buf[i]! >> 4, flags: buf[i]! & 0x0f, body: buf.subarray(j, j + len) });
    i = j + len;
  }
  return [out, buf.slice(i)];
}

/** Topic and payload of a PUBLISH packet. */
export function readPublish(p: MqttPacket): { topic: string; payload: Uint8Array } {
  const tl = (p.body[0]! << 8) | p.body[1]!;
  const topic = dec.decode(p.body.subarray(2, 2 + tl));
  const qos = (p.flags >> 1) & 3;
  const start = 2 + tl + (qos > 0 ? 2 : 0);
  return { topic, payload: p.body.subarray(start) };
}

// ------------------------------------------------------------------ crypto

export interface RoomKeys {
  topic: string;
  key: CryptoKey;
}

export async function roomKeys(code: string): Promise<RoomKeys> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const t = await digest(`dtms-topic-v1|${code}`);
  const k = await digest(`dtms-key-v1|${code}`);
  const hex = Array.from(t.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic: `dtms/v1/${hex}`, key };
}

export async function seal(key: CryptoKey, value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function open(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<unknown> {
  if (data.length < 29) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, key, data.subarray(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null; // wrong room or tampered
  }
}

// ------------------------------------------------------------------ client

/** One broker connection. Publishes and receives raw bytes on one topic. */
class BrokerLink {
  private ws: WebSocket | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  readonly ready: Promise<void>;

  constructor(
    url: string,
    private readonly topic: string,
    private readonly onPayload: (p: Uint8Array<ArrayBuffer>) => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      const fail = () => {
        this.close();
        reject(new Error(`broker unreachable: ${url}`));
      };
      const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
      try {
        this.ws = new WebSocket(url, 'mqtt');
      } catch {
        clearTimeout(timer);
        fail();
        return;
      }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => this.ws?.send(connectPacket(`dtms_${Math.random().toString(36).slice(2, 12)}`));
      this.ws.onerror = () => {
        clearTimeout(timer);
        fail();
      };
      this.ws.onclose = () => this.close();
      this.ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const merged = new Uint8Array(this.buf.length + e.data.byteLength);
        merged.set(this.buf, 0);
        merged.set(new Uint8Array(e.data), this.buf.length);
        const [packets, rest] = readPackets(merged);
        this.buf = rest;
        for (const p of packets) {
          if (p.type === 2) {
            // CONNACK: byte 1 is the return code.
            if (p.body[1] !== 0) {
              clearTimeout(timer);
              fail();
              return;
            }
            this.ws?.send(subscribePacket(1, this.topic));
          } else if (p.type === 9) {
            clearTimeout(timer);
            this.ping = setInterval(() => this.ws?.send(PINGREQ), (KEEPALIVE_S - 5) * 1000);
            resolve();
          } else if (p.type === 3) {
            const { topic, payload } = readPublish(p);
            if (topic === this.topic) this.onPayload(payload.slice());
          }
        }
      };
    });
  }

  publish(payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(publishPacket(this.topic, payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export class MqttSignaling implements Signaling {
  readonly ready: Promise<void>;
  private links: BrokerLink[] = [];
  private keys: RoomKeys | null = null;
  private seen = new Set<string>();
  private listeners: Array<(m: SignalMsg) => void> = [];

  constructor(code: string, brokers: readonly string[] = BROKERS) {
    this.ready = (async () => {
      this.keys = await roomKeys(code);
      const keys = this.keys;
      this.links = brokers.map((url) => new BrokerLink(url, keys.topic, (p) => void this.receive(p)));
      await Promise.any(this.links.map((l) => l.ready)).catch(() => {
        throw new Error('signaling-unreachable');
      });
    })();
  }

  onMessage(cb: (msg: SignalMsg) => void): void {
    this.listeners.push(cb);
  }

  publish(msg: SignalMsg): void {
    const keys = this.keys;
    if (!keys) return;
    const id = Math.random().toString(36).slice(2, 12);
    this.seen.add(id);
    void seal(keys.key, { id, msg }).then((data) => this.links.forEach((l) => l.publish(data)));
  }

  close(): void {
    this.links.forEach((l) => l.close());
    this.listeners = [];
  }

  private async receive(payload: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!this.keys) return;
    const v = (await open(this.keys.key, payload)) as { id?: unknown; msg?: unknown } | null;
    if (!v || typeof v.id !== 'string' || this.seen.has(v.id)) return;
    this.seen.add(v.id);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
    const msg = parseSignal(v.msg);
    if (msg) this.listeners.forEach((cb) => cb(msg));
  }
}

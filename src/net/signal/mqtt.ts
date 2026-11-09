import { RelayLink } from './relayLink';

/**
 * A minimal MQTT 3.1.1 client over WebSocket, enough to meet on one topic of
 * a free public broker: CONNECT, SUBSCRIBE, PUBLISH (QoS 0), PINGREQ.
 */
// Verified by the live relay check in CI (tests/brokers.live.test.ts).
export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
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

// ------------------------------------------------------------------ link

export class MqttLink extends RelayLink {
  private buf: Uint8Array = new Uint8Array(0);
  private ping: ReturnType<typeof setInterval> | null = null;

  constructor(
    url: string,
    private readonly topic: string,
    private readonly onPayload: (p: Uint8Array<ArrayBuffer>) => void,
  ) {
    super(url, 'mqtt');
  }

  publish(payload: Uint8Array): void {
    this.send(publishPacket(this.topic, payload) as Uint8Array<ArrayBuffer>);
  }

  protected onOpen(): void {
    this.buf = new Uint8Array(0);
    this.ws?.send(connectPacket(`dtms_${Math.random().toString(36).slice(2, 12)}`));
  }

  protected onData(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return;
    const merged = new Uint8Array(this.buf.length + data.byteLength);
    merged.set(this.buf, 0);
    merged.set(new Uint8Array(data), this.buf.length);
    const [packets, rest] = readPackets(merged);
    this.buf = rest;
    for (const p of packets) {
      if (p.type === 2) {
        // CONNACK: byte 1 is the return code.
        if (p.body[1] !== 0) this.ws?.close();
        else this.ws?.send(subscribePacket(1, this.topic));
      } else if (p.type === 9) {
        // SUBACK: we are listening.
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send(PINGREQ), (KEEPALIVE_S - 5) * 1000);
        this.markReady();
      } else if (p.type === 3) {
        const { topic, payload } = readPublish(p);
        if (topic === this.topic) this.onPayload(payload.slice());
      }
    }
  }

  protected override onDown(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  override close(): void {
    this.onDown();
    super.close();
  }
}

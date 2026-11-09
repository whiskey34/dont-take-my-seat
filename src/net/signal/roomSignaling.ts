import { open, roomKeys, seal, type RoomKeys } from './crypto';
import { BROKERS, MqttLink } from './mqtt';
import { NOSTR_RELAYS, NostrIdentity, NostrLink } from './nostr';
import type { RelayLink } from './relayLink';
import { parseSignal, type SignalMsg, type Signaling } from './signal';

/**
 * Room-code signaling with no server of our own.
 *
 * Peers that know the room code meet on public relays: MQTT brokers and
 * Nostr relays at the same time, so one blocked port or one dead relay does
 * not stop a game. Messages are encrypted with a key from the room code and
 * de-duplicated by id. Links reconnect by themselves, and immediately when the
 * page becomes visible or the network comes back.
 */
export interface RelayList {
  mqtt: readonly string[];
  nostr: readonly string[];
}

export const DEFAULT_RELAYS: RelayList = { mqtt: BROKERS, nostr: NOSTR_RELAYS };

export class RoomSignaling implements Signaling {
  readonly ready: Promise<void>;
  private links: Array<RelayLink & { publish(p: Uint8Array): void }> = [];
  private keys: RoomKeys | null = null;
  private seen = new Set<string>();
  private listeners: Array<(m: SignalMsg) => void> = [];
  private statusListeners: Array<(up: boolean) => void> = [];
  private closed = false;
  private readonly wakeAll = () => this.links.forEach((l) => l.wake());
  private readonly onVisible = () => {
    if (typeof document === 'undefined' || !document.hidden) this.wakeAll();
  };

  constructor(code: string, relays: RelayList = DEFAULT_RELAYS) {
    this.ready = (async () => {
      this.keys = await roomKeys(code);
      if (this.closed) throw new Error('closed');
      const { topic } = this.keys;
      const receive = (p: Uint8Array<ArrayBuffer>) => void this.receive(p);
      const identity = new NostrIdentity();
      this.links = [
        ...relays.mqtt.map((url) => new MqttLink(url, topic, receive)),
        ...relays.nostr.map((url) => new NostrLink(url, topic, identity, receive)),
      ];
      for (const l of this.links) l.onStatus = () => this.emitStatus();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
      if (typeof window !== 'undefined') window.addEventListener('online', this.wakeAll);
      await Promise.any(this.links.map((l) => l.ready)).catch(() => {
        throw new Error('signaling-unreachable');
      });
    })();
    this.ready.catch(() => {});
  }

  /** True when at least one relay is connected. */
  get isUp(): boolean {
    return this.links.some((l) => l.isUp);
  }

  /** Names of relays currently connected (for diagnostics). */
  get connectedRelays(): string[] {
    return this.links.filter((l) => l.isUp).map((l) => new URL(l.url).hostname);
  }

  onMessage(cb: (msg: SignalMsg) => void): void {
    this.listeners.push(cb);
  }

  /** Notified when the room becomes reachable or unreachable. */
  onStatus(cb: (up: boolean) => void): void {
    this.statusListeners.push(cb);
  }

  publish(msg: SignalMsg): void {
    const keys = this.keys;
    if (!keys || this.closed) return;
    const id = Math.random().toString(36).slice(2, 12);
    this.seen.add(id);
    void seal(keys.key, { id, msg }).then((data) => this.links.forEach((l) => l.publish(data)));
  }

  close(): void {
    this.closed = true;
    this.links.forEach((l) => l.close());
    this.listeners = [];
    this.statusListeners = [];
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('online', this.wakeAll);
  }

  private emitStatus(): void {
    const up = this.isUp;
    this.statusListeners.forEach((cb) => cb(up));
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

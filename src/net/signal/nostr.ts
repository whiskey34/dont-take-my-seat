import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64, toBase64 } from './crypto';
import { RelayLink } from './relayLink';

/**
 * Second signaling path: public Nostr relays over wss on port 443, which
 * networks rarely block (unlike MQTT's 8084/8884). Events are "ephemeral"
 * (relays forward but do not store them) and carry the already-encrypted
 * room message, so relays learn nothing about the game.
 */
// Verified by the live relay check in CI (tests/brokers.live.test.ts).
export const NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://offchain.pub'];
// Tried and not forwarding ephemeral events: nos.lol, nostr.mom, relay.nostr.band.
export const NOSTR_KIND = 21437; // ephemeral range 20000-29999

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** A throwaway identity per room session; it only signs relay envelopes. */
export class NostrIdentity {
  private readonly sk = schnorr.utils.randomSecretKey();
  readonly pubkey = hex(schnorr.getPublicKey(this.sk));

  sign(topic: string, content: string): NostrEvent {
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [['t', topic]];
    const id = sha256(enc.encode(JSON.stringify([0, this.pubkey, created_at, NOSTR_KIND, tags, content])));
    return { id: hex(id), pubkey: this.pubkey, created_at, kind: NOSTR_KIND, tags, content, sig: hex(schnorr.sign(id, this.sk)) };
  }
}

export class NostrLink extends RelayLink {
  private readonly sub = `dtms${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    url: string,
    private readonly topic: string,
    private readonly identity: NostrIdentity,
    private readonly onPayload: (p: Uint8Array<ArrayBuffer>) => void,
  ) {
    super(url);
  }

  publish(payload: Uint8Array): void {
    this.send(JSON.stringify(['EVENT', this.identity.sign(this.topic, toBase64(payload))]));
  }

  protected onOpen(): void {
    const since = Math.floor(Date.now() / 1000) - 30;
    this.ws?.send(JSON.stringify(['REQ', this.sub, { kinds: [NOSTR_KIND], '#t': [this.topic], since }]));
    this.markReady();
  }

  protected onData(data: unknown): void {
    if (typeof data !== 'string' || data.length > 64_000) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== 'EVENT' || msg[1] !== this.sub) return;
    const ev = msg[2] as Partial<NostrEvent> | undefined;
    if (!ev || ev.kind !== NOSTR_KIND || ev.pubkey === this.identity.pubkey || typeof ev.content !== 'string') return;
    if (!ev.tags?.some((t) => t[0] === 't' && t[1] === this.topic)) return;
    // The content is AES-GCM sealed with the room key; that already proves it
    // came from someone with the code, so the Nostr signature is not checked.
    const bytes = fromBase64(ev.content);
    if (bytes) this.onPayload(bytes);
  }
}

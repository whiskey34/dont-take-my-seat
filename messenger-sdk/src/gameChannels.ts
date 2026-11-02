import type { Channel, PeerLink } from './session';

/**
 * Adds two data channels for mini games to an RTCPeerConnection the chat
 * app already has with a contact:
 *   - 'reliable' (ordered)            for lobby, actions, events
 *   - 'fast'     (unordered, no retry) for movement and snapshots
 *
 * They are "negotiated" channels with fixed ids, so both phones create them
 * locally and no extra signaling is needed. Call `GameLinks.attach()` on BOTH
 * sides right after `new RTCPeerConnection(...)`, before the offer/answer.
 */
export const GAME_CHANNEL_IDS = { reliable: 1001, fast: 1002 } as const;

interface Pair {
  rel: RTCDataChannel;
  fast: RTCDataChannel;
}

export type GameMessageHandler = (from: string, channel: Channel, data: string) => void;
export type PeerStateHandler = (userId: string, connected: boolean) => void;

export class GameLinks implements PeerLink {
  private readonly peers = new Map<string, Pair>();
  private onMessage: GameMessageHandler = () => {};
  private onState: PeerStateHandler = () => {};

  /** Every message arriving on any contact's game channels. */
  setMessageHandler(fn: GameMessageHandler): void {
    this.onMessage = fn;
  }

  /** Called when a contact's game channels open or close. */
  setStateHandler(fn: PeerStateHandler): void {
    this.onState = fn;
  }

  attach(userId: string, pc: RTCPeerConnection): void {
    this.peers.get(userId)?.rel.close();
    const rel = pc.createDataChannel('minigame-reliable', { negotiated: true, id: GAME_CHANNEL_IDS.reliable, ordered: true });
    const fast = pc.createDataChannel('minigame-fast', { negotiated: true, id: GAME_CHANNEL_IDS.fast, ordered: false, maxRetransmits: 0 });
    const pair = { rel, fast };
    this.peers.set(userId, pair);
    const current = () => this.peers.get(userId) === pair;
    rel.onopen = () => current() && this.onState(userId, true);
    rel.onclose = () => {
      if (!current()) return;
      this.peers.delete(userId);
      this.onState(userId, false);
    };
    rel.onmessage = (e) => typeof e.data === 'string' && current() && this.onMessage(userId, 'reliable', e.data);
    fast.onmessage = (e) => typeof e.data === 'string' && current() && this.onMessage(userId, 'fast', e.data);
  }

  isConnected(userId: string): boolean {
    return this.peers.get(userId)?.rel.readyState === 'open';
  }

  send(userId: string, channel: Channel, data: string): void {
    const pair = this.peers.get(userId);
    if (!pair || pair.rel.readyState !== 'open') return;
    const ch = channel === 'fast' && pair.fast.readyState === 'open' ? pair.fast : pair.rel;
    if (ch === pair.fast && ch.bufferedAmount > 64_000) return; // drop stale movement data
    try {
      ch.send(data);
    } catch {
      /* closing */
    }
  }

  detach(userId: string): void {
    const pair = this.peers.get(userId);
    if (!pair) return;
    this.peers.delete(userId);
    pair.rel.close();
    pair.fast.close();
    this.onState(userId, false);
  }
}

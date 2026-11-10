import type { Channel } from '../transport';

const STUN_ONLY: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const GATHER_TIMEOUT_MS = 2500;
/** TURN over TCP/TLS takes longer to allocate; wait a bit more when it is configured. */
const GATHER_TIMEOUT_TURN_MS = 5000;
/** Once a relay candidate exists, give the rest a moment and send the offer. */
const AFTER_RELAY_MS = 700;

/**
 * One WebRTC connection with two data channels:
 * 'reliable' (ordered) and 'fast' (unordered, no retransmits).
 * ICE candidates are gathered up front, so one offer and one answer are
 * the only signaling messages needed.
 */
export class Peer {
  private readonly pc: RTCPeerConnection;
  private readonly rel: RTCDataChannel;
  private readonly fast: RTCDataChannel;
  private opened = false;
  private closed = false;
  private readonly withTurn: boolean;
  private relaySeen = false;
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  onMessage: (channel: Channel, data: string) => void = () => {};

  constructor(iceServers: RTCIceServer[] = STUN_ONLY) {
    this.withTurn = iceServers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn')));
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.addEventListener('icecandidate', (e) => {
      if (e.candidate?.type === 'relay') this.relaySeen = true;
    });
    // Negotiated channels exist on both sides without an extra round trip.
    this.rel = this.pc.createDataChannel('reliable', { negotiated: true, id: 0, ordered: true });
    this.fast = this.pc.createDataChannel('fast', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    this.rel.onopen = () => {
      if (!this.opened && !this.closed) {
        this.opened = true;
        this.onOpen();
      }
    };
    this.rel.onclose = () => this.close();
    this.rel.onmessage = (e) => typeof e.data === 'string' && this.onMessage('reliable', e.data);
    this.fast.onmessage = (e) => typeof e.data === 'string' && this.onMessage('fast', e.data);
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close();
    };
  }

  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.gatheredSdp();
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.gatheredSdp();
  }

  async acceptAnswer(sdp: string): Promise<void> {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  send(channel: Channel, data: string): void {
    if (!this.isOpen) return;
    const ch = channel === 'fast' && this.fast.readyState === 'open' ? this.fast : this.rel;
    try {
      // Skip unreliable sends when the buffer backs up; newer data follows.
      if (ch === this.fast && ch.bufferedAmount > 64_000) return;
      ch.send(data);
    } catch {
      /* channel closing */
    }
  }

  /** Round-trip time to the other side in ms (from WebRTC's own measurements), or null. */
  async rtt(): Promise<number | null> {
    try {
      const stats = await this.pc.getStats();
      let best: number | null = null;
      stats.forEach((r: { type: string; state?: string; nominated?: boolean; selected?: boolean; currentRoundTripTime?: number }) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected) && typeof r.currentRoundTripTime === 'number') {
          best ??= Math.round(r.currentRoundTripTime * 1000);
        }
      });
      return best;
    } catch {
      return null;
    }
  }

  /** "direct UDP 35 ms", "TURN TCP 80 ms", … from the selected ICE candidate pair. */
  async route(): Promise<string> {
    try {
      const stats = await this.pc.getStats();
      type Pair = { type: string; state?: string; nominated?: boolean; selected?: boolean; localCandidateId?: string; currentRoundTripTime?: number };
      let pair: Pair | undefined;
      stats.forEach((r: Pair) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair ??= r;
      });
      if (!pair?.localCandidateId) return this.pc.connectionState;
      const local = stats.get(pair.localCandidateId) as { candidateType?: string; protocol?: string; relayProtocol?: string } | undefined;
      const kind = local?.candidateType === 'relay' ? `TURN ${(local.relayProtocol ?? local.protocol ?? '').toUpperCase()}` : `direct ${(local?.protocol ?? '').toUpperCase()}`;
      const rtt = pair.currentRoundTripTime === undefined ? '' : ` ${Math.round(pair.currentRoundTripTime * 1000)} ms`;
      return kind + rtt;
    } catch {
      return '?';
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.onClose();
  }

  private gatheredSdp(): Promise<string> {
    return new Promise((resolve) => {
      let finished = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const done = () => {
        if (finished) return;
        finished = true;
        timers.forEach(clearTimeout);
        resolve(this.pc.localDescription?.sdp ?? '');
      };
      if (this.pc.iceGatheringState === 'complete') return done();
      timers.push(setTimeout(done, this.withTurn ? GATHER_TIMEOUT_TURN_MS : GATHER_TIMEOUT_MS));
      const onRelay = () => {
        if (this.relaySeen) timers.push(setTimeout(done, AFTER_RELAY_MS));
      };
      this.pc.addEventListener('icecandidate', onRelay);
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') done();
      });
    });
  }
}

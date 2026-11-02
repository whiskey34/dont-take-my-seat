/** Messages exchanged only to set up WebRTC connections. */
export type SignalMsg =
  | { type: 'hello'; from: string }
  | { type: 'offer'; from: string; to: string; sdp: string }
  | { type: 'answer'; from: string; to: string; sdp: string };

/** A shared "room" where peers that know the room code can post messages. */
export interface Signaling {
  /** Resolves once at least one path is connected. Rejects if none can be reached. */
  ready: Promise<void>;
  publish(msg: SignalMsg): void;
  onMessage(cb: (msg: SignalMsg) => void): void;
  close(): void;
}

export function parseSignal(v: unknown): SignalMsg | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Record<string, unknown>;
  const id = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 40;
  if (!id(m.from)) return null;
  if (m.type === 'hello') return { type: 'hello', from: m.from as string };
  if ((m.type === 'offer' || m.type === 'answer') && id(m.to) && typeof m.sdp === 'string' && m.sdp.length < 20_000) {
    return { type: m.type, from: m.from as string, to: m.to as string, sdp: m.sdp };
  }
  return null;
}

/** Room codes avoid look-alike characters (0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

export function newRoomCode(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  return [...s].every((c) => CODE_ALPHABET.includes(c)) ? s : null;
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

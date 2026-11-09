/**
 * Room secrecy. The topic and the AES-GCM key both come from the room code,
 * so relays only ever see an opaque topic and encrypted bytes.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

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

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

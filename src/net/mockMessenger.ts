import type { MessengerUser, ToMessenger } from './messenger';

/**
 * A pretend messenger for testing in a normal browser: open the game in
 * several tabs with ?mock=messenger&user=u1 (u1 is the host), user=u2, ...
 * Tabs talk through BroadcastChannel exactly like the real SDK would.
 */
const USERS: MessengerUser[] = [
  { id: 'u1', name: 'Andi' },
  { id: 'u2', name: 'Bunga' },
  { id: 'u3', name: 'Cahya' },
  { id: 'u4', name: 'Dewi' },
];

type Wire = { kind: 'here' | 'leave' | 'hi'; from: string } | { kind: 'data'; from: string; to: string; channel: string; data: string };

export function installMockMessenger(params: URLSearchParams): boolean {
  if (params.get('mock') !== 'messenger') return false;
  const me = USERS.find((u) => u.id === params.get('user')) ?? USERS[0]!;
  const session = params.get('session') ?? 'demo';
  const bc = new BroadcastChannel(`dtms-mock-messenger-${session}`);
  const present = new Set<string>();
  const deliver = (msg: unknown) => setTimeout(() => window.miniGameReceive?.(JSON.stringify(msg)), 0);
  const userOf = (id: string) => USERS.find((u) => u.id === id) ?? { id, name: id };
  let started = false;

  bc.onmessage = (e: MessageEvent<Wire>) => {
    const w = e.data;
    if (w.from === me.id) return;
    if (w.kind === 'here' || w.kind === 'hi') {
      if (w.kind === 'here') bc.postMessage({ kind: 'hi', from: me.id } satisfies Wire);
      if (!present.has(w.from)) {
        present.add(w.from);
        if (started) deliver({ type: 'peer', event: 'join', user: userOf(w.from) });
      }
    } else if (w.kind === 'leave') {
      if (present.delete(w.from) && started) deliver({ type: 'peer', event: 'leave', user: userOf(w.from) });
    } else if (w.kind === 'data' && w.to === me.id) {
      deliver({ type: 'message', from: w.from, channel: w.channel, data: w.data });
    }
  };
  bc.postMessage({ kind: 'here', from: me.id } satisfies Wire);
  window.addEventListener('pagehide', () => bc.postMessage({ kind: 'leave', from: me.id } satisfies Wire));

  window.MiniGameBridge = {
    postMessage(json: string) {
      const msg = JSON.parse(json) as ToMessenger;
      if (msg.type === 'ready') {
        started = true;
        deliver({
          type: 'init',
          sdk: 1,
          self: { ...me, lang: navigator.language },
          session: { id: session, hostId: USERS[0]!.id, participants: [...present].map(userOf) },
        });
      } else if (msg.type === 'send') {
        bc.postMessage({ kind: 'data', from: me.id, to: msg.to, channel: msg.channel, data: msg.data } satisfies Wire);
      } else if (msg.type === 'result') {
        console.info('[mock messenger] result card:', msg.text);
      }
    },
  };
  return true;
}

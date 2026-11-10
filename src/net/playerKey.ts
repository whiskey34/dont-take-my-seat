/**
 * Which player key this tab uses.
 *
 * The device key is saved in settings so a player can rejoin after closing
 * the app. Two tabs of the same browser would share it, though, and the host
 * would mistake the second for the first coming back. So a tab claims the key
 * with a Web Lock; if another tab already holds it, this tab gets its own key
 * (kept in sessionStorage, so reloading the tab keeps it).
 */
const TAB_KEY = 'dtms.tabPlayerKey';

function randomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function readTabKey(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

function writeTabKey(k: string): void {
  try {
    sessionStorage.setItem(TAB_KEY, k);
  } catch {
    /* ignore */
  }
}

/** Holds a lock for the life of the tab; resolves to whether we got it. */
function claim(key: string): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    locks
      .request(`dtms-player-${key}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Keep the lock until the tab closes.
        return lock ? new Promise<void>(() => {}) : undefined;
      })
      .catch(() => resolve(true));
  });
}

export async function claimPlayerKey(deviceKey: string): Promise<string> {
  const tab = readTabKey();
  if (tab) {
    await claim(tab);
    return tab;
  }
  if (await claim(deviceKey)) return deviceKey;
  const own = randomKey();
  writeTabKey(own);
  await claim(own);
  return own;
}

/** Inside a chat app the chat user id is already unique and stable. */
export function chatPlayerKey(userId: string): string {
  return `chat_${userId.replace(/[^A-Za-z0-9_-]/g, '_')}`.padEnd(8, '_').slice(0, 40);
}

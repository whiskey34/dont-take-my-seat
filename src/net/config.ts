/**
 * Where the Cloudflare Worker lives (signaling + TURN credentials).
 * Set at build time with VITE_SIGNAL_URL (GitHub repository variable
 * SIGNAL_URL), e.g. https://dtms-signal.<account>.workers.dev.
 * For testing, ?worker=<url> overrides it.
 */
function fromUrl(): string | null {
  try {
    return new URLSearchParams(location.search).get('worker');
  } catch {
    return null;
  }
}

function clean(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
  } catch {
    return '';
  }
}

export const SIGNAL_URL: string = clean(fromUrl()) || clean(import.meta.env.VITE_SIGNAL_URL as string | undefined);

/** The Worker's WebSocket address for a room topic. */
export function workerRoomUrl(base: string, topic: string): string {
  return `${base.replace(/^http/, 'ws')}/room/${encodeURIComponent(topic)}`;
}

/**
 * Web app plumbing: offline cache (service worker), safe updates and the
 * "Install app" button.
 *
 * A new version is downloaded in the background and waits. It is applied
 * (one page reload) only when the game says it is safe: in the main menu,
 * never in the middle of a game.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const UPDATE_CHECK_MS = 30 * 60 * 1000;

let registration: ServiceWorkerRegistration | null = null;
let isSafe: () => boolean = () => false;
let installEvent: InstallPromptEvent | null = null;
let onInstallChange: () => void = () => {};
let reloading = false;

export function isInstalled(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

/** iPhone/iPad Safari has no install prompt; players use Share → Add to Home Screen. */
export function needsIosHint(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  return ios && !isInstalled();
}

export function canInstall(): boolean {
  return installEvent !== null && !isInstalled();
}

export async function install(): Promise<void> {
  const e = installEvent;
  if (!e) return;
  installEvent = null;
  await e.prompt();
  await e.userChoice.catch(() => undefined);
  onInstallChange();
}

/** Applies a downloaded update now, if one is waiting. Call only from a menu. */
export function applyPendingUpdate(): void {
  const waiting = registration?.waiting;
  // Only an update: on the very first install there is no old version to replace.
  if (!waiting || !navigator.serviceWorker.controller || reloading) return;
  reloading = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

function updateArrived(): void {
  if (isSafe()) applyPendingUpdate();
}

export function initPwa(opts: { isSafeToReload: () => boolean; onInstallChange: () => void }): void {
  isSafe = opts.isSafeToReload;
  onInstallChange = opts.onInstallChange;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the browser banner
    installEvent = e as InstallPromptEvent;
    onInstallChange();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    onInstallChange();
  });

  // Inside the chat app's iframe the chat owns caching and updates.
  if (new URLSearchParams(location.search).get('embed') === 'messenger') return;
  if (!('serviceWorker' in navigator) || !isSecureContext) return;

  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((reg) => {
      registration = reg;
      if (reg.waiting) updateArrived();
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') updateArrived();
        });
      });
      // Look for new versions now and then, and whenever the game comes back to the screen.
      const check = () => void reg.update().catch(() => {});
      setInterval(check, UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
      });
    })
    .catch(() => {
      /* offline play simply is not available */
    });
}

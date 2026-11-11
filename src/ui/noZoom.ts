/**
 * Keeps the page at 100% on iPhone Safari.
 *
 * Safari ignores `user-scalable=no` and `maximum-scale` in the viewport tag
 * (since iOS 10), so a pinch, a quick double tap, or focusing a small text
 * field could zoom the whole game, and it stayed zoomed. The CSS
 * (`touch-action` on the menus, 16 px text fields) handles most cases; this
 * blocks the rest:
 * - `gesture*` events are WebKit's pinch events; cancelling them stops the zoom.
 * - A second finger moving on the page (a pinch on a menu) is cancelled.
 * - A second tap within 350 ms outside a text field is cancelled (double-tap zoom).
 * - When the keyboard closes, the page is scrolled back to the top-left
 *   (Safari leaves it shifted).
 */
export function preventPageZoom(): void {
  const stop = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, { passive: false });
  }

  document.addEventListener(
    'touchmove',
    (e) => {
      const scale = (e as TouchEvent & { scale?: number }).scale;
      if (e.touches.length > 1 || (scale !== undefined && scale !== 1)) stop(e);
    },
    { passive: false },
  );

  let lastTap = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = e.timeStamp;
      const quick = now - lastTap < 350;
      lastTap = now;
      if (!quick || isTextField(e.target)) return;
      // The game's own controls use pointer events, which still fire.
      stop(e);
      // Keep buttons working on the second of two quick taps.
      const el = e.target instanceof Element ? e.target.closest('button') : null;
      if (el && !el.disabled) el.click();
    },
    { passive: false },
  );

  document.addEventListener('focusout', (e) => {
    if (!isTextField(e.target)) return;
    // Wait for the keyboard to slide away, then undo Safari's scroll.
    window.setTimeout(() => {
      if (!isTextField(document.activeElement)) window.scrollTo(0, 0);
    }, 120);
  });
}

function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t.isContentEditable) return true;
  return t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'radio';
}

/**
 * The page's real layout size. Not `innerWidth`/`innerHeight`: on iPhone those
 * shrink while the page is zoomed or the keyboard is open, which made the 3D
 * view resize to the zoomed area.
 */
export function layoutSize(): { width: number; height: number } {
  const el = document.documentElement;
  return {
    width: el.clientWidth || window.innerWidth,
    height: el.clientHeight || window.innerHeight,
  };
}

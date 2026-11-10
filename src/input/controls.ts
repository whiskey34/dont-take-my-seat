import type { PlayerInput } from '../core/types';

/**
 * Touch joystick (floating, left side of the screen), action button, and
 * keyboard (WASD / arrows + Space). Screen "up" maps to -z in the world.
 */
export class Controls {
  private stick = { x: 0, y: 0 };
  private stickPointer: number | null = null;
  private origin = { x: 0, y: 0 };
  private keys = new Set<string>();
  private actionQueued = false;
  private radius = 56;
  private reach = 1; // stick travel for full speed, relative to the drawn stick size
  private fixed = false; // stick stays in its spot instead of jumping to the thumb
  private dead = 0.12;
  private curve = 1;
  /** Event counts for the ?debug panel. */
  private seen = { down: 0, up: 0, blur: 0, ptr: 0, last: '' };

  constructor(
    private readonly zone: HTMLElement,
    private readonly base: HTMLElement,
    private readonly knob: HTMLElement,
    actionButton: HTMLElement,
  ) {
    zone.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    zone.addEventListener('lostpointercapture', this.onUp);
    actionButton.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.actionQueued = true;
      actionButton.classList.add('pressed');
    });
    const release = () => actionButton.classList.remove('pressed');
    actionButton.addEventListener('pointerup', release);
    actionButton.addEventListener('pointerleave', release);
    // Capture phase: nothing on the page can swallow the keys before we see them.
    window.addEventListener('keydown', (e) => {
      this.seen.down++;
      this.seen.last = `${e.code || e.key}${e.repeat ? ' (repeat)' : ''} → ${(document.activeElement as HTMLElement | null)?.id || document.activeElement?.tagName || '-'}`;
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'Enter') {
        this.actionQueued = true;
        e.preventDefault();
      }
      this.keys.add(e.code);
    }, true);
    window.addEventListener('keyup', (e) => {
      this.seen.up++;
      this.keys.delete(e.code);
    }, true);
    window.addEventListener('blur', () => {
      this.seen.blur++;
      this.reset();
    });
  }

  /**
   * Stick sensitivity 1 (calm) to 5 (twitchy). Higher levels reach full
   * speed with a shorter thumb movement and respond sooner off-centre.
   */
  setSensitivity(level: number): void {
    const i = Math.max(1, Math.min(5, Math.round(level))) - 1;
    // The stick is drawn at a size that suits the screen; sensitivity only
    // changes how far the thumb has to move for full speed.
    this.reach = [1.3, 1.15, 1, 0.85, 0.7][i]!;
    this.dead = [0.14, 0.12, 0.1, 0.08, 0.06][i]!;
    this.curve = [1.5, 1.25, 1, 0.85, 0.7][i]!;
  }

  /** Returns this tick's input. The action press is consumed. */
  read(): PlayerInput {
    let x = this.stick.x;
    let y = this.stick.y;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    const action = this.actionQueued;
    this.actionQueued = false;
    return { moveX: clamp(x), moveZ: clamp(y), action };
  }

  /** Fixed stick (stays in its spot) or floating (jumps to where the thumb lands). */
  setFixed(fixed: boolean): void {
    this.fixed = fixed;
    this.release();
  }

  /** Current stick/keys state without consuming anything (debug panel). */
  peek(): string {
    const touch = this.stickPointer === null ? 'no touch' : `touch #${this.stickPointer}`;
    const n = this.seen;
    return `${this.stick.x.toFixed(2)}, ${this.stick.y.toFixed(2)} · ${touch} · keys [${[...this.keys].join(' ')}]\nevents down ${n.down} up ${n.up} blur ${n.blur} stick ${n.ptr} · last ${n.last}`;
  }

  reset(): void {
    this.release();
    this.keys.clear();
    this.actionQueued = false;
  }

  private onDown = (e: PointerEvent) => {
    this.seen.ptr++;
    // A new touch always takes the stick. If the browser lost the old finger's
    // "up" event (iOS does this), the stick would otherwise stay stuck.
    e.preventDefault();
    this.stickPointer = e.pointerId;
    try {
      // Keep receiving this finger's moves and release even outside the zone.
      this.zone.setPointerCapture(e.pointerId);
    } catch {
      /* not supported */
    }
    const drawn = this.base.offsetWidth / 2 || 60;
    this.radius = Math.max(30, (drawn - 4) * this.reach);
    if (this.fixed) {
      // Fixed stick: measure from its centre, wherever the thumb lands.
      const b = this.base.getBoundingClientRect();
      this.origin = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    } else {
      this.origin = { x: e.clientX, y: e.clientY };
      const rect = this.zone.getBoundingClientRect();
      this.base.style.left = `${e.clientX - rect.left}px`;
      this.base.style.top = `${e.clientY - rect.top}px`;
    }
    this.base.classList.add('active');
    this.updateKnob(0, 0);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) return;
    const rawX = e.clientX - this.origin.x;
    const rawY = e.clientY - this.origin.y;
    const d = Math.hypot(rawX, rawY);
    // Knob stays on the rim when the thumb goes further; the direction and
    // strength come from the real thumb position. (Before, the clamped knob
    // offset was divided by the real distance, so pushing the thumb further
    // made the player slower, down to a third of full speed.)
    const k = d > this.radius ? this.radius / d : 1;
    this.updateKnob(rawX * k, rawY * k);
    const mag = Math.min(1, d / this.radius);
    const scaled = mag < this.dead ? 0 : ((mag - this.dead) / (1 - this.dead)) ** this.curve;
    this.stick = d > 0 ? { x: (rawX / d) * scaled, y: (rawY / d) * scaled } : { x: 0, y: 0 };
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) return;
    this.release();
  };

  /** Back to rest: centred knob, stick in its home spot (bottom left). */
  private release(): void {
    this.stickPointer = null;
    this.stick = { x: 0, y: 0 };
    this.base.classList.remove('active');
    this.base.style.left = '';
    this.base.style.top = '';
    this.updateKnob(0, 0);
  }

  private updateKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

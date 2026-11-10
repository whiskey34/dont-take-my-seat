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
  private dead = 0.12;
  private curve = 1;

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
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'KeyJ' || e.code === 'Enter') {
        this.actionQueued = true;
        e.preventDefault();
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
  }

  /**
   * Stick sensitivity 1 (calm) to 5 (twitchy). Higher levels reach full
   * speed with a shorter thumb movement and respond sooner off-centre.
   */
  setSensitivity(level: number): void {
    const i = Math.max(1, Math.min(5, Math.round(level))) - 1;
    this.radius = [80, 68, 56, 46, 38][i]!;
    this.dead = [0.14, 0.12, 0.1, 0.08, 0.06][i]!;
    this.curve = [1.5, 1.25, 1, 0.85, 0.7][i]!;
    this.base.style.setProperty('--stick-size', `${this.radius * 2 + 8}px`);
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

  /** Current stick/keys state without consuming anything (debug panel). */
  peek(): string {
    const touch = this.stickPointer === null ? 'no touch' : `touch #${this.stickPointer}`;
    return `${this.stick.x.toFixed(2)}, ${this.stick.y.toFixed(2)} · ${touch} · keys [${[...this.keys].join(' ')}]`;
  }

  reset(): void {
    this.stick = { x: 0, y: 0 };
    this.stickPointer = null;
    this.keys.clear();
    this.actionQueued = false;
    this.base.classList.remove('active');
  }

  private onDown = (e: PointerEvent) => {
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
    this.origin = { x: e.clientX, y: e.clientY };
    const rect = this.zone.getBoundingClientRect();
    this.base.style.left = `${e.clientX - rect.left}px`;
    this.base.style.top = `${e.clientY - rect.top}px`;
    this.base.classList.add('active');
    this.updateKnob(0, 0);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) return;
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const d = Math.hypot(dx, dy);
    if (d > this.radius) {
      dx = (dx / d) * this.radius;
      dy = (dy / d) * this.radius;
    }
    this.updateKnob(dx, dy);
    const mag = Math.min(1, d / this.radius);
    const scaled = mag < this.dead ? 0 : ((mag - this.dead) / (1 - this.dead)) ** this.curve;
    this.stick = d > 0 ? { x: (dx / d) * scaled, y: (dy / d) * scaled } : { x: 0, y: 0 };
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = null;
    this.stick = { x: 0, y: 0 };
    this.base.classList.remove('active');
  };

  private updateKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

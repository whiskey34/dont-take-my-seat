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
  private readonly radius = 56;

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

  reset(): void {
    this.stick = { x: 0, y: 0 };
    this.stickPointer = null;
    this.keys.clear();
    this.actionQueued = false;
    this.base.classList.remove('active');
  }

  private onDown = (e: PointerEvent) => {
    if (this.stickPointer !== null) return;
    e.preventDefault();
    this.stickPointer = e.pointerId;
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
    const dead = 0.12;
    const mag = Math.min(1, d / this.radius);
    const scaled = mag < dead ? 0 : (mag - dead) / (1 - dead);
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

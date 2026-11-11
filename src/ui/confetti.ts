/**
 * Confetti for the end of a game: a full-screen canvas above everything that
 * ignores touches, two bursts from the bottom corners plus a short rain from
 * the top, then it removes itself. Skipped when the device asks for less motion.
 */
const COLORS = ['#ffc02e', '#ff5a4e', '#22c55e', '#3b82f6', '#f472b6', '#ffffff', '#a78bfa'];
const DURATION_MS = 4200;

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  w: number;
  h: number;
  color: string;
  wobble: number;
}

let running: (() => void) | null = null;

export function confetti(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  running?.();
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.setAttribute('aria-hidden', 'true');
  document.getElementById('app')?.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas.remove();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);

  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const bits: Bit[] = [];
  const make = (x: number, y: number, vx: number, vy: number): Bit => ({
    x,
    y,
    vx,
    vy,
    rot: rand(0, Math.PI * 2),
    spin: rand(-12, 12),
    w: rand(6, 10),
    h: rand(3, 6),
    color: COLORS[Math.floor(rand(0, COLORS.length))]!,
    wobble: rand(0, Math.PI * 2),
  });
  const scale = Math.max(0.7, Math.min(1.4, h / 420));
  // Two cannons in the bottom corners, aimed up and inwards.
  for (let i = 0; i < 70; i++) {
    const speed = rand(520, 900) * scale;
    const left = rand(-1.25, -0.95); // radians from the x axis (up and to the right)
    bits.push(make(0, h, Math.cos(left) * -speed * 0.55, Math.sin(left) * speed));
    bits.push(make(w, h, Math.cos(left) * speed * 0.55, Math.sin(left) * speed));
  }
  // A gentle rain from the top.
  for (let i = 0; i < 60; i++) bits.push(make(rand(0, w), rand(-h * 0.6, -10), rand(-40, 40), rand(40, 160)));

  let last = performance.now();
  const start = last;
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    canvas.remove();
    if (running === stop) running = null;
  };
  running = stop;

  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = now - start;
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = age > DURATION_MS - 800 ? Math.max(0, (DURATION_MS - age) / 800) : 1;
    for (const b of bits) {
      b.vy += 900 * dt; // gravity
      b.vx *= 1 - 1.6 * dt; // air
      b.vy = Math.min(b.vy, 260); // paper falls slowly
      b.wobble += dt * 6;
      b.x += (b.vx + Math.sin(b.wobble) * 30) * dt;
      b.y += b.vy * dt;
      b.rot += b.spin * dt;
      if (b.y > h + 20) continue;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(1, Math.cos(b.wobble)); // flutter
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (age < DURATION_MS) raf = requestAnimationFrame(frame);
    else stop();
  };
  raf = requestAnimationFrame(frame);
}

/** Leaving the results early: no confetti over the menu. */
export function stopConfetti(): void {
  running?.();
}

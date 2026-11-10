/** Tiny synthesized sound effects: no audio files to download. */
type Sound = 'chime' | 'push' | 'sit' | 'out' | 'win' | 'kick' | 'tick' | 'brake' | 'pickup' | 'block' | 'whistle';

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

export const isSoundEnabled = (): boolean => enabled;

/** Must be called from a user gesture (browsers block audio before one). */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.18, slideTo?: number): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function play(sound: Sound): void {
  if (!enabled || !ctx) return;
  switch (sound) {
    case 'chime': // station "ding-dong"
      tone(659, 0, 0.6, 'sine', 0.2);
      tone(523, 0.32, 0.8, 'sine', 0.2);
      break;
    case 'push':
      tone(160, 0, 0.14, 'square', 0.12, 70);
      break;
    case 'sit':
      tone(520, 0, 0.09, 'triangle', 0.18);
      tone(780, 0.07, 0.12, 'triangle', 0.18);
      break;
    case 'whistle': // officer's whistle: two sharp trills
      for (let i = 0; i < 6; i++) tone(i % 2 ? 2650 : 2900, i * 0.045, 0.06, 'square', 0.05);
      tone(2800, 0.33, 0.4, 'square', 0.06);
      break;
    case 'kick':
      tone(300, 0, 0.25, 'sawtooth', 0.1, 150);
      break;
    case 'out':
      tone(220, 0, 0.5, 'sawtooth', 0.1, 90);
      break;
    case 'win':
      [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, 0.3, 'triangle', 0.16));
      break;
    case 'brake': // wheels screeching
      tone(1800, 0, 0.5, 'sawtooth', 0.05, 900);
      tone(1400, 0.02, 0.45, 'square', 0.03, 700);
      break;
    case 'pickup':
      [660, 880, 1320].forEach((f, i) => tone(f, i * 0.06, 0.15, 'triangle', 0.14));
      break;
    case 'block':
      tone(420, 0, 0.12, 'sine', 0.14, 620);
      break;
    case 'tick':
      tone(1200, 0, 0.04, 'square', 0.05);
      break;
  }
}

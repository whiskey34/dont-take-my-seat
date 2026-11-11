import type { Lang } from '../i18n';
import { cleanKey, cleanName } from '../net/protocol';
import { normalizeCode } from '../net/signal/signal';

export interface Settings {
  lang: Lang | null; // null = follow the device
  sound: boolean;
  difficulty: 'easy' | 'normal';
  sensitivity: number; // 1..5
  name: string;
  /** This device's player key: lets it rejoin a game it dropped out of. */
  playerKey: string;
  /** The last room joined with a code, for the "Rejoin" button. */
  lastRoom: { code: string; at: number } | null;
  /** Show tips for items, challenges and rules during a game (on by default). */
  tips: boolean;
  /** Touch controls: size, which side the stick is on, stick follows the thumb or stays put, vibration. */
  ctlSize: 's' | 'm' | 'l';
  ctlSide: 'left' | 'right';
  ctlMode: 'floating' | 'fixed';
  vibrate: boolean;
}

const KEY = 'dtms.settings.v1';

function newPlayerKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const defaults = (): Settings => ({ lang: null, sound: true, difficulty: 'normal', sensitivity: 3, name: '', playerKey: newPlayerKey(), lastRoom: null, tips: true, ctlSize: 'm', ctlSide: 'left', ctlMode: 'floating', vibrate: true });

/** Settings are a convenience: if storage is unavailable we just use defaults. */
export function loadSettings(): Settings {
  let s: Settings;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      s = defaults();
    } else {
      const v = JSON.parse(raw) as Partial<Settings>;
      const sens = Number(v.sensitivity);
      const room = v.lastRoom && typeof v.lastRoom === 'object' ? v.lastRoom : null;
      const roomCode = room ? normalizeCode(String(room.code)) : null;
      s = {
        lang: v.lang === 'en' || v.lang === 'id' ? v.lang : null,
        sound: typeof v.sound === 'boolean' ? v.sound : true,
        difficulty: v.difficulty === 'easy' ? 'easy' : 'normal',
        sensitivity: Number.isFinite(sens) ? Math.max(1, Math.min(5, Math.round(sens))) : 3,
        name: typeof v.name === 'string' && v.name.trim() ? cleanName(v.name) : '',
        playerKey: cleanKey(v.playerKey) || newPlayerKey(),
        lastRoom: room && roomCode && Number.isFinite(room.at) ? { code: roomCode, at: Number(room.at) } : null,
        ctlSize: v.ctlSize === 's' || v.ctlSize === 'l' ? v.ctlSize : 'm',
        ctlSide: v.ctlSide === 'right' ? 'right' : 'left',
        ctlMode: v.ctlMode === 'fixed' ? 'fixed' : 'floating',
        vibrate: typeof v.vibrate === 'boolean' ? v.vibrate : true,
        tips: typeof v.tips === 'boolean' ? v.tips : true,
      };
    }
  } catch {
    return defaults();
  }
  saveSettings(s); // keep a newly made player key
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

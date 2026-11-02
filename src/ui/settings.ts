import type { Lang } from '../i18n';
import { cleanName } from '../net/protocol';

export interface Settings {
  lang: Lang | null; // null = follow the device
  sound: boolean;
  difficulty: 'easy' | 'normal';
  sensitivity: number; // 1..5
  name: string;
}

const KEY = 'dtms.settings.v1';
const DEFAULTS: Settings = { lang: null, sound: true, difficulty: 'normal', sensitivity: 3, name: '' };

/** Settings are a convenience: if storage is unavailable we just use defaults. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<Settings>;
    const sens = Number(v.sensitivity);
    return {
      lang: v.lang === 'en' || v.lang === 'id' ? v.lang : null,
      sound: typeof v.sound === 'boolean' ? v.sound : DEFAULTS.sound,
      difficulty: v.difficulty === 'easy' ? 'easy' : 'normal',
      sensitivity: Number.isFinite(sens) ? Math.max(1, Math.min(5, Math.round(sens))) : DEFAULTS.sensitivity,
      name: typeof v.name === 'string' && v.name.trim() ? cleanName(v.name) : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

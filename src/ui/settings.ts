import type { Lang } from '../i18n';

export interface Settings {
  lang: Lang | null; // null = follow the device
  sound: boolean;
  difficulty: 'easy' | 'normal';
}

const KEY = 'dtms.settings.v1';
const DEFAULTS: Settings = { lang: null, sound: true, difficulty: 'normal' };

/** Settings are a convenience: if storage is unavailable we just use defaults. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<Settings>;
    return {
      lang: v.lang === 'en' || v.lang === 'id' ? v.lang : null,
      sound: typeof v.sound === 'boolean' ? v.sound : DEFAULTS.sound,
      difficulty: v.difficulty === 'easy' ? 'easy' : 'normal',
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

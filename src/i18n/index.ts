import { en, type Strings } from './en';
import { id } from './id';

export type Lang = 'en' | 'id';
type TextKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings];

const tables: Record<Lang, Strings> = { en, id };
let current: Lang = 'en';
const listeners = new Set<() => void>();

export function detectLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'id' || base === 'in' || base === 'ms') return 'id';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
  listeners.forEach((fn) => fn());
}

export const getLang = (): Lang => current;

export function onLangChange(fn: () => void): void {
  listeners.add(fn);
}

export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  const text = tables[current][key];
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

export const rules = (): readonly string[] => tables[current].rules;

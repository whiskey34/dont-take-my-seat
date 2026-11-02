import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { id } from '../src/i18n/id';
import { detectLang } from '../src/i18n/index';

describe('i18n', () => {
  it('Indonesian has the same keys, placeholders and rule count as English', () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const a = en[key];
      const b = id[key];
      if (typeof a === 'string' && typeof b === 'string') {
        expect(b.match(/\{\w+\}/g) ?? [], key).toEqual(a.match(/\{\w+\}/g) ?? []);
        expect(b.length, key).toBeGreaterThan(0);
      }
    }
    expect(id.rules).toHaveLength(en.rules.length);
  });

  it('detects Indonesian from the device language', () => {
    expect(detectLang(['id-ID', 'en-US'])).toBe('id');
    expect(detectLang(['in'])).toBe('id');
    expect(detectLang(['en-GB'])).toBe('en');
    expect(detectLang(['fr-FR'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });
});

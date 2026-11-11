// The settings kept between launches.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORMATS } from '../io/export';
import { loadPrefs, savePrefs } from './persist';

/** A store that keeps what it is given, standing in for the browser's. */
function storage(): Storage {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k), clear: () => kept.clear(), key: () => null, length: 0 } as Storage;
}

describe('the settings kept between launches', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('remember the export format, whichever of the formats it is', () => {
    vi.stubGlobal('localStorage', storage());
    for (const { id } of FORMATS) {
      savePrefs({ ...loadPrefs(), format: id });
      expect(loadPrefs().format, id).toBe(id);
    }
  });

  it('fall back on STL for a format the app no longer has, or never had', () => {
    const store = storage();
    vi.stubGlobal('localStorage', store);
    savePrefs({ ...loadPrefs(), format: 'step' });
    const [key] = ['plastikcad:prefs:v1'];
    store.setItem(key, JSON.stringify({ ...JSON.parse(store.getItem(key) ?? '{}'), format: 'iges' }));
    expect(loadPrefs().format).toBe('stl');
  });
});

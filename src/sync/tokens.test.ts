// Where the Google sign-in is kept: the system's keychain on desktop, the app's own storage where
// there is none, and the move from the one to the other.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tokens } from './google';

/** A pretend keychain: whether the app is one that has any, whether it answers, and the one secret it holds. */
const keychain = vi.hoisted(() => ({ there: true, answers: true, secret: null as string | null, writes: 0 }));
vi.mock('../platform', () => {
  const ask = <T>(answer: () => T) => async (): Promise<T> => {
    if (!keychain.answers) throw new Error('Could not use the system keychain');
    return answer();
  };
  return {
    isAndroid: () => false,
    isDesktop: () => true,
    hasKeychain: () => keychain.there,
    secretRead: ask(() => keychain.secret),
    secretWrite: async (secret: string) => ask(() => void ((keychain.secret = secret), keychain.writes++))(),
    secretRemove: ask(() => void (keychain.secret = null)),
  };
});

/** The app's own storage. */
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});
const KEY = 'plastikcad:google:v1';
const tokens = (access: string, expires = 1000): Tokens => ({ access, refresh: 'refresh', expires, email: 'me@example.com' });
const inKeychain = (): Tokens | null => (keychain.secret ? (JSON.parse(keychain.secret) as Tokens) : null);
const inStorage = (): Tokens | null => (storage.has(KEY) ? (JSON.parse(storage.get(KEY)!) as Tokens) : null);

/** The module afresh, as at a start of the app: what it has learnt of the keychain is forgotten. */
const start = async () => {
  vi.resetModules();
  return import('./google');
};

beforeEach(() => {
  Object.assign(keychain, { there: true, answers: true, secret: null, writes: 0 });
  storage.clear();
});

describe('the Google sign-in on a desktop with a keychain', () => {
  it('is kept in the keychain and nowhere else, and read back from it', async () => {
    const google = await start();
    expect(await google.loadTokens()).toBeNull();
    await google.saveTokens(tokens('a'));
    expect(inKeychain()).toEqual(tokens('a'));
    expect(inStorage()).toBeNull();
    expect(google.signInKeptIn()).toBe('keychain');
    expect(await (await start()).loadTokens()).toEqual(tokens('a'));
  });

  it('moves one an earlier version left in the app\'s storage into the keychain, the first time', async () => {
    storage.set(KEY, JSON.stringify(tokens('old')));
    const google = await start();
    expect(await google.loadTokens()).toEqual(tokens('old'));
    expect(inKeychain()).toEqual(tokens('old'));
    expect(inStorage()).toBeNull();
    // And not again.
    expect(await (await start()).loadTokens()).toEqual(tokens('old'));
    expect(keychain.writes).toBe(1);
  });

  it('takes the later of two, when there is one in each place', async () => {
    keychain.secret = JSON.stringify(tokens('stale', 1000));
    storage.set(KEY, JSON.stringify(tokens('fresh', 2000)));
    expect(await (await start()).loadTokens()).toEqual(tokens('fresh', 2000));
    expect(inKeychain()).toEqual(tokens('fresh', 2000));
    expect(inStorage()).toBeNull();
    // The other way round: the keychain's stands, and the leftover goes.
    storage.set(KEY, JSON.stringify(tokens('older', 500)));
    expect(await (await start()).loadTokens()).toEqual(tokens('fresh', 2000));
    expect(inStorage()).toBeNull();
  });

  it('forgets the sign-in in both places', async () => {
    const google = await start();
    await google.saveTokens(tokens('a'));
    storage.set(KEY, JSON.stringify(tokens('left over')));
    await google.saveTokens(null);
    expect(inKeychain()).toBeNull();
    expect(inStorage()).toBeNull();
    expect(await (await start()).loadTokens()).toBeNull();
  });

  it('keeps the last of several saved one after the other', async () => {
    const google = await start();
    void google.saveTokens(tokens('first'));
    void google.saveTokens(tokens('second'));
    await google.saveTokens(tokens('third'));
    expect(inKeychain()).toEqual(tokens('third'));
  });

  it('reads what is not a sign-in as none', async () => {
    keychain.secret = '{"access": 3}';
    expect(await (await start()).loadTokens()).toBeNull();
    keychain.secret = 'not JSON';
    expect(await (await start()).loadTokens()).toBeNull();
  });
});

describe('the Google sign-in where there is no keychain to keep it in', () => {
  it('is kept in the app\'s storage when the keychain does not answer, as it was before', async () => {
    keychain.answers = false;
    storage.set(KEY, JSON.stringify(tokens('a')));
    const google = await start();
    expect(await google.loadTokens()).toEqual(tokens('a'));
    expect(inStorage()).toEqual(tokens('a'));
    await google.saveTokens(tokens('b'));
    expect(inStorage()).toEqual(tokens('b'));
    expect(google.signInKeptIn()).toBe('storage');
    await google.saveTokens(null);
    expect(inStorage()).toBeNull();
  });

  it('goes to the app\'s storage when the keychain stops answering, and back to the keychain at the next start', async () => {
    const google = await start();
    await google.saveTokens(tokens('a', 1000));
    keychain.answers = false;
    await google.saveTokens(tokens('b', 2000));
    expect(inStorage()).toEqual(tokens('b', 2000));
    expect(inKeychain()).toEqual(tokens('a', 1000));
    keychain.answers = true;
    expect(await (await start()).loadTokens()).toEqual(tokens('b', 2000));
    expect(inKeychain()).toEqual(tokens('b', 2000));
    expect(inStorage()).toBeNull();
  });

  it('never asks for a keychain in the Android app or a browser', async () => {
    keychain.there = false;
    keychain.answers = false;
    const google = await start();
    await google.saveTokens(tokens('a'));
    expect(inStorage()).toEqual(tokens('a'));
    expect(await google.loadTokens()).toEqual(tokens('a'));
    expect(google.signInKeptIn()).toBe('storage');
  });
});

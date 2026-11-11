// The save dialog on desktop, stood in for: the app adds the ending a typed name lacks, and asks before that
// name replaces a file, which the dialog itself never looked at.
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The files on the pretend disk, what the dialog returns, and what the user answers to a question. */
const there = new Set<string>();
let picked: string | null = null;
let answer = true;
const asked: string[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: async (name: string, args?: { path?: string }) => {
    if (name === 'is_there') return there.has(args!.path!);
    if (name === 'file_name') return null;
    throw new Error(`not expected here: ${name}`);
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: async () => picked,
  ask: async (message: string) => {
    asked.push(message);
    return answer;
  },
}));

const { chooseSave } = await import('./platform');
const stl = [{ name: 'STL', extensions: ['stl'] }];

beforeEach(() => {
  there.clear();
  asked.length = 0;
  answer = true;
});

describe('a name typed into the save dialog without its ending', () => {
  it('gets the ending, with no question when no file of that name is there', async () => {
    picked = '/home/me/part';
    expect(await chooseSave('part.stl', stl, 'model/stl')).toEqual({ path: '/home/me/part.stl', name: 'part.stl' });
    expect(asked).toEqual([]);
  });

  it('is asked about when a file of that name is there, and is not written when the answer is no', async () => {
    picked = '/home/me/part';
    there.add('/home/me/part.stl');
    expect(await chooseSave('part.stl', stl, 'model/stl')).toEqual({ path: '/home/me/part.stl', name: 'part.stl' });
    expect(asked).toEqual(['"part.stl" is already there. Replace it?']);
    answer = false;
    expect(await chooseSave('part.stl', stl, 'model/stl')).toBeNull();
  });

  it('is not asked about twice when the name was typed whole: the dialog has asked already', async () => {
    picked = '/home/me/part.stl';
    there.add('/home/me/part.stl');
    expect(await chooseSave('part.stl', stl, 'model/stl')).toEqual({ path: '/home/me/part.stl', name: 'part.stl' });
    expect(asked).toEqual([]);
  });
});

// The parts of the platform layer that are plain logic.
import { describe, expect, it } from 'vitest';
import { asError } from './errors';
import { withExtension } from './platform';

describe('a name from the save dialog', () => {
  const stl = [{ name: 'STL mesh', extensions: ['stl'] }];

  it('keeps a name that already says what the file is, whatever its case', () => {
    expect(withExtension('/home/me/part.stl', stl)).toBe('/home/me/part.stl');
    expect(withExtension('C:\\Users\\me\\Part.STL', stl)).toBe('C:\\Users\\me\\Part.STL');
  });

  it('adds the extension to a name typed without it, or with another', () => {
    expect(withExtension('/home/me/part', stl)).toBe('/home/me/part.stl');
    expect(withExtension('/home/me/part.v2', stl)).toBe('/home/me/part.v2.stl');
    expect(withExtension('/home/me.d/part', stl)).toBe('/home/me.d/part.stl');
    expect(withExtension('/home/me/bracket.obj', [{ name: 'Design', extensions: ['plastikcad'] }])).toBe('/home/me/bracket.obj.plastikcad');
  });

  it('leaves the name alone when nothing says what it should be', () => {
    expect(withExtension('/home/me/part', [])).toBe('/home/me/part');
  });
});

describe('what the native side rejects with', () => {
  it('becomes an Error with the words it carried', () => {
    const kept = new Error('kept as it is');
    expect(asError(kept)).toBe(kept);
    expect(asError('Could not read Box.plastikcad').message).toBe('Could not read Box.plastikcad');
    // An Android plugin rejects with an object; its message is what the app compares and shows.
    expect(asError({ message: 'needs-sign-in' }).message).toBe('needs-sign-in');
    expect(asError({ message: 'cancelled', code: 'x' }).message).toBe('cancelled');
  });

  it('never reads as "[object Object]"', () => {
    for (const reason of [{}, { code: 7 }, { message: '' }, null, undefined, 3, { message: { nested: true } }]) {
      const { message } = asError(reason);
      expect(message).not.toContain('[object');
      expect(message.length).toBeGreaterThan(0);
    }
    expect(asError({ code: 7 }).message).toBe('{"code":7}');
  });
});

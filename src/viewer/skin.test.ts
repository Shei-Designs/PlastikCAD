// The skin painter's bookkeeping without a browser: image decoding is stood in for by a stub.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../model/types';
import { SkinPainter } from './skin';

const picture = (name: string): Asset => ({ kind: 'image', name, mime: 'image/png', data: btoa('not a picture'), width: 1, height: 1 });
const skin = { kind: 'texture', asset: 'img', mode: 'tile', scale: 10, turn: 0, color: '#ffffff' } as const;
const bitmap = () => ({ width: 4, height: 2, close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const none: ReadonlySet<string> = new Set();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkinPainter.retain', () => {
  it('closes and forgets the images no object wears, and keeps the rest', async () => {
    const made: Record<string, ReturnType<typeof bitmap>> = {};
    let next = '';
    vi.stubGlobal('createImageBitmap', () => Promise.resolve((made[next] = bitmap())));
    const assets = { a: picture('a.png'), b: picture('b.png') };
    const painter = new SkinPainter(() => undefined);
    next = 'a';
    painter.image('a', assets);
    await tick();
    next = 'b';
    painter.image('b', assets);
    await tick();

    const dropped = made.b;
    painter.retain(new Set(['a']), none);
    expect(dropped.close).toHaveBeenCalledTimes(1);
    expect(made.a.close).not.toHaveBeenCalled();
    expect(painter.image('a', assets)).toBe(made.a);
    // Worn again, the dropped picture is decoded again.
    expect(painter.image('b', assets)).toBeNull();
    await tick();
    expect(made.b).not.toBe(dropped);
    expect(painter.image('b', assets)).toBe(made.b);
  });

  it('closes a picture that arrives after it was let go, without waking anyone', async () => {
    const image = bitmap();
    let settle!: () => void;
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => (settle = () => resolve(image))));
    const onReady = vi.fn();
    const painter = new SkinPainter(onReady);
    const assets = { img: picture('label.png') };
    painter.image('img', assets);
    painter.retain(none, none);
    settle();
    await tick();
    expect(image.close).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
  });
});

describe('SkinPainter failures', () => {
  it('tries a missing picture again once the design has it', async () => {
    const image = bitmap();
    const decode = vi.fn(() => Promise.resolve(image));
    vi.stubGlobal('createImageBitmap', decode);
    const painter = new SkinPainter(() => undefined);
    expect(() => painter.paint('k', skin, {})).toThrow('could not be read');
    // Still missing: still failed, and nothing is decoded.
    expect(() => painter.paint('k', skin, {})).toThrow('could not be read');
    expect(decode).not.toHaveBeenCalled();
    const assets = { img: picture('label.png') };
    expect(painter.paint('k', skin, assets)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(1);
    await tick();
    expect(painter.image('img', assets)).toBe(image);
  });

  it('does not decode an unreadable picture over and over, but tries one that replaces it', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('bad bytes')));
    vi.stubGlobal('createImageBitmap', decode);
    const painter = new SkinPainter(() => undefined);
    const assets = { img: picture('label.png') };
    expect(painter.paint('k', skin, assets)).toBeNull();
    await tick();
    expect(() => painter.paint('k', skin, assets)).toThrow('The picture "label.png" could not be read.');
    expect(() => painter.paint('k', skin, assets)).toThrow();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(painter.paint('k', skin, { img: picture('label.png') })).toBeNull();
    expect(decode).toHaveBeenCalledTimes(2);
  });
});

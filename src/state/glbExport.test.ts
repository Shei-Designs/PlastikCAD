// The skin painter and the GLB export without a browser: image decoding is
// stood in for by a stub, and the kernel by a single triangle.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeShape } from '../model/ops';
import type { Asset, SceneNode } from '../model/types';
import { SkinPainter } from '../viewer/skin';

vi.mock('./geometry', () => ({
  geometry: {
    prepare: async () => ({
      export: async () => ({
        mesh: { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), triangles: new Uint32Array([0, 1, 2]) },
        bounds: { min: [0, 0, 0], max: [10, 10, 0] },
        volume: 0,
        warnings: [],
      }),
    }),
  },
}));

const assets: Record<string, Asset> = {
  img: { kind: 'image', name: 'label.png', mime: 'image/png', data: btoa('not a picture'), width: 1, height: 1 },
};
const skin = { kind: 'texture', asset: 'img', mode: 'tile', scale: 10, turn: 0, color: '#ffffff' } as const;

/** Stands in for the browser's decoder; `decode` settles the next call. */
function stubDecoder(decode: () => Promise<ImageBitmap>): void {
  vi.stubGlobal('createImageBitmap', decode);
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SkinPainter', () => {
  it('tells its owner when a picture cannot be decoded, so the wait ends in an error', async () => {
    stubDecoder(() => Promise.reject(new Error('bad bytes')));
    const onReady = vi.fn();
    const painter = new SkinPainter(onReady);
    expect(painter.paint('k', skin, assets, true)).toBeNull();
    await tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(() => painter.paint('k', skin, assets, true)).toThrow('The picture "label.png" could not be read.');
  });

  it('hands out a decoded picture and wakes its owner once', async () => {
    const image = { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap;
    stubDecoder(() => Promise.resolve(image));
    const onReady = vi.fn();
    const painter = new SkinPainter(onReady);
    expect(painter.image('img', assets)).toBeNull();
    await tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(painter.image('img', assets)).toBe(image);
    painter.dispose();
    expect(image.close).toHaveBeenCalledTimes(1);
  });

  it('wakes a waiter when disposed, and drops what arrives afterwards', async () => {
    const image = { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap;
    let settle!: () => void;
    stubDecoder(() => new Promise<ImageBitmap>((resolve) => (settle = () => resolve(image))));
    const onReady = vi.fn();
    const painter = new SkinPainter(onReady);
    painter.image('img', assets);
    painter.dispose();
    expect(onReady).toHaveBeenCalledTimes(1);
    settle();
    await tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(image.close).toHaveBeenCalledTimes(1);
  });
});

describe('exportGlb', () => {
  it('fails with the picture that could not be read instead of waiting forever', async () => {
    stubDecoder(() => Promise.reject(new Error('bad bytes')));
    const { exportGlb } = await import('./glbExport');
    const node: SceneNode = { ...makeShape('box'), texture: { asset: 'img', mode: 'tile', scale: 10, turn: 0 } };
    await expect(exportGlb([node], assets, 'Design')).rejects.toThrow('The picture "label.png" could not be read.');
  });
});

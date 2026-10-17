import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';
import { describe, expect, it } from 'vitest';
import { initKernel, patchBinding } from './kernel';

// A kernel of its own (the shared one is patched at `initKernel`), with a hand on its memory.
async function freshKernel(): Promise<{ k: ManifoldToplevel; heap: () => number }> {
  let memory: WebAssembly.Memory | undefined;
  const bytes = readFileSync(new URL('../../node_modules/manifold-3d/manifold.wasm', import.meta.url));
  const k = await Module({
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
      void WebAssembly.instantiate(bytes, imports).then(({ instance }) => {
        memory = Object.values(instance.exports).find((e) => e instanceof WebAssembly.Memory) as WebAssembly.Memory;
        done(instance);
      });
      return {};
    },
  } as never);
  k.setup();
  return { k, heap: () => memory!.buffer.byteLength };
}

/** An outline of many points, like a gear's: `teeth` square bumps around a circle of radius 10. */
const gear = (teeth: number): [number, number][] =>
  Array.from({ length: teeth * 8 }, (_, i) => {
    const a = (i * 2 * Math.PI) / (teeth * 8);
    const r = 10 + (i % 8 < 4 ? 1 : -1);
    return [r * Math.cos(a), r * Math.sin(a)];
  });

describe('initKernel', () => {
  it('tries again after a failure to load', async () => {
    await expect(initKernel('/nowhere/manifold.wasm')).rejects.toThrow();
    const k = await initKernel();
    expect(k.Manifold).toBeDefined();
    expect(await initKernel()).toBe(k);
  });
});

describe('the mended binding', () => {
  const ROUNDS = 500;

  it('leaks the polygons of every extrusion as shipped', async () => {
    const { k, heap } = await freshKernel();
    const cs = new k.CrossSection(gear(250), 'EvenOdd');
    const before = heap();
    for (let i = 0; i < ROUNDS; i++) cs.extrude(5).delete();
    expect(heap()).toBeGreaterThan(before);
    cs.delete();
  }, 60000);

  it('keeps the heap where it is once mended', async () => {
    const { k, heap } = await freshKernel();
    patchBinding(k);
    const cs = new k.CrossSection(gear(250), 'EvenOdd');
    const before = heap();
    for (let i = 0; i < ROUNDS; i++) {
      cs.extrude(5).delete();
      if (i % 10 === 0) cs.revolve(16).delete();
    }
    expect(heap()).toBe(before);
    cs.delete();
  }, 60000);
});

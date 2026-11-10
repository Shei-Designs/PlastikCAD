import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';
import { describe, expect, it } from 'vitest';
import { buildSolid } from '../parts/evaluate';
import type { Solid } from '../parts/types';
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

  it('leaks the points of every section made from polygons, and of every one read back, as shipped', async () => {
    const { k, heap } = await freshKernel();
    const before = heap();
    for (let i = 0; i < ROUNDS; i++) new k.CrossSection(gear(250), 'EvenOdd').delete();
    const made = heap();
    expect(made).toBeGreaterThan(before);
    const cs = new k.CrossSection(gear(250), 'EvenOdd');
    for (let i = 0; i < ROUNDS; i++) cs.toPolygons();
    expect(heap()).toBeGreaterThan(made);
    cs.delete();
  }, 60000);

  it('makes sections from polygons and reads them back without the heap growing, once mended', async () => {
    const { k, heap } = await freshKernel();
    patchBinding(k);
    const outline = gear(250);
    const hole = gear(250)
      .map(([x, y]): [number, number] => [x / 2, y / 2])
      .reverse();
    const round = () => {
      const cs = new k.CrossSection([outline, hole], 'EvenOdd');
      const single = k.CrossSection.ofPolygons(outline, 'NonZero');
      cs.toPolygons();
      single.delete();
      cs.delete();
    };
    round();
    const before = heap();
    for (let i = 0; i < ROUNDS; i++) round();
    expect(heap()).toBe(before);
  }, 60000);

  it('makes the same sections as the binding did', async () => {
    const { k } = await freshKernel();
    const outline = gear(12);
    const hole = gear(12)
      .map(([x, y]): [number, number] => [x / 2, y / 2])
      .reverse();
    const shipped = [new k.CrossSection([outline, hole], 'EvenOdd'), new k.CrossSection(outline, 'Positive'), new k.CrossSection([outline, hole.slice().reverse()], 'NonZero'), new k.CrossSection([outline.slice().reverse()], 'Negative'), new k.CrossSection(outline)];
    const Shipped = k.CrossSection;
    patchBinding(k);
    expect(k.CrossSection).not.toBe(Shipped);
    const mended = [new k.CrossSection([outline, hole], 'EvenOdd'), new k.CrossSection(outline, 'Positive'), new k.CrossSection([outline, hole.slice().reverse()], 'NonZero'), new k.CrossSection([outline.slice().reverse()], 'Negative'), new k.CrossSection(outline)];
    shipped.forEach((theirs, i) => {
      const ours = mended[i];
      expect(ours).toBeInstanceOf(k.CrossSection);
      expect(ours.area()).toBeCloseTo(theirs.area(), 9);
      expect(ours.numVert()).toBe(theirs.numVert());
      expect(ours.numContour()).toBe(theirs.numContour());
      expect(ours.toPolygons()).toEqual(theirs.toPolygons());
    });
    // A ring: the gear's area less that of the hole, a quarter of it.
    expect(mended[0].area()).toBeCloseTo(mended[1].area() * 0.75, 6);
    expect(mended[0].toPolygons()).toHaveLength(2);
    // What hangs off the class is still there.
    const square = k.CrossSection.square([2, 3]);
    expect(square.area()).toBeCloseTo(6, 9);
    const both = k.CrossSection.union([square, mended[1]]);
    expect(both.area()).toBeGreaterThanOrEqual(mended[1].area());
    for (const o of [...shipped, ...mended, square, both]) o.delete();
  });

  it('rebuilds an extruded and a revolved part over and over without the heap growing', async () => {
    const { k, heap } = await freshKernel();
    patchBinding(k);
    // Round outlines of a great many points: the leak went by the point, and a convex outline costs little to fill.
    const circle = (r: number, cx = 0, n = 6000): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i * 2 * Math.PI) / n), r * Math.sin((i * 2 * Math.PI) / n)]);
    // As a part's generator describes them: a disc, and a ring turned about Z.
    const disc: Solid = { op: 'extrude', shape: [circle(10)], height: 5 };
    const ring: Solid = { op: 'revolve', profile: circle(2, 10), segments: 8 };
    const rebuild = () => {
      const garbage: { delete(): void }[] = [];
      const keep = <T extends { delete(): void }>(o: T): T => {
        garbage.push(o);
        return o;
      };
      const volumes = [buildSolid(k, disc, keep).volume(), buildSolid(k, ring, keep).volume()];
      for (const o of garbage) o.delete();
      return volumes;
    };
    const [flat, round] = rebuild();
    expect(flat).toBeCloseTo(Math.PI * 100 * 5, 2);
    // Pappus, for an octagon's worth of turn: the section's area times the path of its middle.
    expect(round).toBeCloseTo(Math.PI * 4 * 8 * Math.sin(Math.PI / 4) * 10, 1);
    const before = heap();
    for (let i = 0; i < 40; i++) rebuild();
    expect(heap()).toBe(before);
  }, 60000);
});

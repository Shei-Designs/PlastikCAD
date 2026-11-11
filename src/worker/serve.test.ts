import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadOcc } from '../io/occ';
import { assetCount, cacheSize, clearCache, forgetAssets, initKernel } from '../geometry/kernel';
import { geomKey } from '../model/geomKey';
import { makeShape } from '../model/ops';
import type { Asset, ImportNode, PartNode } from '../model/types';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { kernelFault, serve } from './serve';

// The kernel as it is, but for one request that can be made to end the way running out of memory does.
vi.mock('../geometry/kernel', async (original) => {
  const actual = await original<typeof import('../geometry/kernel')>();
  return {
    ...actual,
    partBox: (node: PartNode) => {
      if (node.name === 'Trap') throw new WebAssembly.RuntimeError('memory access out of bounds');
      return actual.partBox(node);
    },
  };
});

afterAll(() => {
  clearCache();
  forgetAssets([]);
});

function encode(a: Float32Array | Uint32Array): string {
  let bin = '';
  for (const b of new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// A tetrahedron, as an imported mesh.
const solid: Asset = { kind: 'mesh', positions: encode(Float32Array.from([0, 0, 0, 6, 0, 0, 0, 6, 0, 0, 0, 6])), triangles: encode(Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2])) };
const imported: ImportNode = { id: 'i', type: 'import', name: 'Tetrahedron', asset: 'tetra', natural: [6, 6, 6], size: [6, 6, 6], pos: [0, 0, 0], rot: [0, 0, 0], hole: false, color: '#ffffff' };
const box = makeShape('box');
const part = (name: string): PartNode => ({ id: 'p', type: 'part', name, part: 'spur', params: {}, natural: [1, 1, 1], size: [1, 1, 1], pos: [0, 0, 0], rot: [0, 0, 0], hole: false, color: '#ffffff' });

/** A worker's message loop with its answers collected, and a kernel that fails to load `failures` times first. */
function worker(failures = 0) {
  const posts: WorkerResponse[] = [];
  let loads = 0;
  const receive = serve(
    (msg) => posts.push(msg),
    () => (loads++ < failures ? Promise.reject(new Error('The kernel could not be fetched')) : initKernel()),
  );
  /** Sends requests and waits for the answers to all that want one. */
  const ask = async (...requests: WorkerRequest[]): Promise<WorkerResponse[]> => {
    const from = posts.length;
    for (const req of requests) receive(req);
    const wanted = requests.filter((r) => 'id' in r).length;
    await vi.waitFor(() => expect(posts.length).toBe(from + wanted));
    return posts.slice(from);
  };
  return { ask };
}

describe('the worker', () => {
  it('answers in the order asked, and tries to load the kernel again after a failure', async () => {
    const { ask } = worker(1);
    const answers = await ask(
      { type: 'assets', assets: { tetra: solid } },
      { type: 'build', id: 1, key: geomKey(imported), node: imported },
      { type: 'build', id: 2, key: geomKey(box), node: box },
      { type: 'measure', id: 3, nodes: [box, imported] },
    );
    // The first request found no kernel; the load was tried again for the second.
    expect(answers.map((a) => [a.type, a.id])).toEqual([
      ['error', 1],
      ['built', 2],
      ['measured', 3],
    ]);
    expect(answers[0].type === 'error' && answers[0].message).toBe('The kernel could not be fetched');
    // The imported data sent while there was no kernel was kept for the requests that followed.
    expect(answers[2].type === 'measured' && answers[2].bounds?.max).toEqual([10, 10, 20]);
    const [again] = await ask({ type: 'build', id: 4, key: geomKey(imported), node: imported });
    expect(again.type === 'built' && again.result.volume).toBeCloseTo(36, 4);
  });

  it('starts a fresh kernel after one has stopped, keeping the imported data', async () => {
    const { ask } = worker();
    await ask({ type: 'assets', assets: { tetra: solid } }, { type: 'build', id: 1, key: geomKey(box), node: box });
    const before = await initKernel();
    expect(cacheSize()).toBeGreaterThan(0);
    const answers = await ask({ type: 'partBox', id: 2, node: part('Trap') }, { type: 'build', id: 3, key: geomKey(imported), node: imported }, { type: 'partBox', id: 4, node: part('Gear') });
    expect(answers.map((a) => [a.type, a.id])).toEqual([
      ['error', 2],
      ['built', 3],
      ['partBoxed', 4],
    ]);
    expect(answers[0].type === 'error' && answers[0].message).toBe('The geometry kernel stopped (memory access out of bounds), most likely for lack of memory, and was restarted.');
    expect(answers[1].type === 'built' && answers[1].result.volume).toBeCloseTo(36, 4);
    expect(await initKernel()).not.toBe(before);
    // Only what was built since is cached (the imported mesh, and the gear that was measured, kept for
    // when it is shown); the old kernel's solids went with it.
    expect(cacheSize()).toBe(2);
    expect(assetCount()).toBe(1);
  });

  it('reads a file without a kernel, into what a design keeps', async () => {
    // The kernel never loads here: reading a file must not wait for it.
    const { ask } = worker(Infinity);
    const stl = (corners: number[][]): Uint8Array => {
      const lines = ['solid t'];
      for (const f of corners) {
        lines.push('facet normal 0 0 0', 'outer loop');
        for (let k = 0; k < 9; k += 3) lines.push(`vertex ${f[k]} ${f[k + 1]} ${f[k + 2]}`);
        lines.push('endloop', 'endfacet');
      }
      return new TextEncoder().encode([...lines, 'endsolid t', ''].join('\n'));
    };
    // The tetrahedron above, moved off the origin.
    const tetra = [[10, 0, 0, 10, 6, 0, 16, 0, 0], [10, 0, 0, 16, 0, 0, 10, 0, 6], [16, 0, 0, 10, 6, 0, 10, 0, 6], [10, 0, 0, 10, 0, 6, 10, 6, 0]];
    const [read] = await ask({ type: 'import', id: 1, name: 'tetra.stl', bytes: stl(tetra), companions: [] });
    if (read.type !== 'imported' || read.result.kind !== 'model') throw new Error(`unexpected answer: ${JSON.stringify(read)}`);
    const [part] = read.result.parts;
    expect(part).toMatchObject({ name: 'tetra', size: [6, 6, 6], center: [13, 3, 3] });
    expect(part.key).toMatch(/^mesh-[0-9a-z]+-[0-9a-z]+$/);
    // Centered on its box, twelve corners' worth of numbers and four triangles.
    const positions = new Float32Array(Uint8Array.from(atob(part.asset.positions), (c) => c.charCodeAt(0)).buffer);
    expect([...positions].sort((a, b) => a - b)).toEqual([-3, -3, -3, -3, -3, -3, -3, -3, -3, 3, 3, 3]);
    expect(atob(part.asset.triangles).length).toBe(4 * 3 * 4);
    expect(read.result.warnings).toEqual([]);
    // What cannot be read is answered with words for the user.
    const [refused] = await ask({ type: 'import', id: 2, name: 'empty.stl', bytes: new Uint8Array(0), companions: [] });
    expect(refused).toEqual({ type: 'error', id: 2, message: 'This STL file is empty.' });
  });

  it('holds a tiny file without a unit until it is told the unit', async () => {
    const { ask } = worker(Infinity);
    const bytes = new TextEncoder().encode(['v 0 0 0', 'v 0.2 0 0', 'v 0 0.1 0', 'v 0 0 0.05', 'f 1 3 2', 'f 1 2 4', 'f 2 3 4', 'f 1 4 3', ''].join('\n'));
    const [asked] = await ask({ type: 'import', id: 1, name: 'link.obj', bytes, companions: [] });
    expect(asked.type).toBe('imported');
    if (asked.type !== 'imported' || asked.result.kind !== 'units') throw new Error('unexpected answer');
    expect(asked.result.held).toBe(1);
    expect(asked.result.extent.map((v) => Number(v.toFixed(6)))).toEqual([0.2, 0.1, 0.05]);
    const [told] = await ask({ type: 'importHeld', id: 2, held: 1, scale: 1000 });
    if (told.type !== 'imported' || told.result.kind !== 'model') throw new Error('unexpected answer');
    expect(told.result.parts[0].size.map(Math.round)).toEqual([200, 100, 50]);
    // Held once: asking again, or for another request's file, finds nothing.
    const [gone] = await ask({ type: 'importHeld', id: 3, held: 1, scale: 1000 });
    expect(gone).toEqual({ type: 'error', id: 3, message: 'The file is no longer at hand. Import it again.' });
    // With the unit given from the start nothing is asked: an OBJ read again with its material library.
    const [again] = await ask({ type: 'import', id: 4, name: 'link.obj', bytes, companions: [], scale: 25.4 });
    if (again.type !== 'imported' || again.result.kind !== 'model') throw new Error('unexpected answer');
    expect(again.result.parts[0].size.map((v) => Number(v.toFixed(3)))).toEqual([5.08, 2.54, 1.27]);
    // A 3MF says its unit, and a model of ordinary size needs none: neither is asked about.
    const big = new TextEncoder().encode(['v 0 0 0', 'v 20 0 0', 'v 0 10 0', 'v 0 0 5', 'f 1 3 2', 'f 1 2 4', 'f 2 3 4', 'f 1 4 3', ''].join('\n'));
    const [plain] = await ask({ type: 'import', id: 5, name: 'bracket.obj', bytes: big, companions: [] });
    expect(plain.type === 'imported' && plain.result.kind).toBe('model');
  });

  it('reads a STEP file with OpenCascade, loaded when the first one comes', async () => {
    const posts: WorkerResponse[] = [];
    let loads = 0;
    const receive = serve(
      (msg) => posts.push(msg),
      () => Promise.reject(new Error('no kernel is needed')),
      () => {
        loads++;
        return loadOcc({ wasmBinary: readFileSync(fileURLToPath(new URL('../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))) });
      },
    );
    const step = readFileSync(fileURLToPath(new URL('../../fixtures/step/plate.step', import.meta.url)));
    // A plain file first: nothing is loaded for it.
    receive({ type: 'import', id: 1, name: 'a.obj', bytes: new TextEncoder().encode('v 0 0 0\nv 20 0 0\nv 0 10 0\nv 0 0 5\nf 1 3 2\nf 1 2 4\nf 2 3 4\nf 1 4 3\n'), companions: [] });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(loads).toBe(0);
    receive({ type: 'import', id: 2, name: 'plate.step', bytes: new Uint8Array(step), companions: [] });
    receive({ type: 'import', id: 3, name: 'unnamed', bytes: new Uint8Array(step), companions: [] });
    await vi.waitFor(() => expect(posts).toHaveLength(3), { timeout: 30_000 });
    const [, named, sniffed] = posts;
    if (named.type !== 'imported' || named.result.kind !== 'model') throw new Error(`unexpected answer: ${JSON.stringify(named).slice(0, 200)}`);
    expect(named.result.parts).toHaveLength(1);
    expect(named.result.parts[0]).toMatchObject({ name: 'plate', size: [40, 30, 10], center: [20, 15, 5] });
    // Told by its first line when its name does not say.
    expect(sniffed.type === 'imported' && sniffed.result.kind).toBe('model');
    // Where there is no OpenCascade to load (a test of the app without it), a STEP file is refused in words.
    const bare: WorkerResponse[] = [];
    serve((msg) => bare.push(msg), () => Promise.resolve())({ type: 'import', id: 1, name: 'plate.step', bytes: new Uint8Array(step), companions: [] });
    await vi.waitFor(() => expect(bare).toHaveLength(1));
    expect(bare[0]).toEqual({ type: 'error', id: 1, message: 'STEP files cannot be read here.' });
  }, 60_000);

  it('reads what the Measure tool takes hold of, on a mesh placed by a matrix', async () => {
    const { ask } = worker(Infinity);
    // A unit square of two triangles, made 10 wide and moved 5 up.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
    const matrix = [10, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1];
    const [answer] = await ask({ type: 'features', id: 1, positions, matrix });
    if (answer.type !== 'features') throw new Error('unexpected answer');
    const { points, edges, regions, box } = answer.result;
    expect(points.map((p) => p.join(',')).sort()).toEqual(['0,0,5', '0,1,5', '10,0,5', '10,1,5']);
    expect(edges).toHaveLength(4);
    expect(regions).toHaveLength(1);
    expect(regions[0].area).toBeCloseTo(10, 6);
    expect(box).toEqual([5, 0.5, 5]);
  });

  it('answers an ordinary failure with its message and carries on with the same kernel', async () => {
    const { ask } = worker();
    const before = await initKernel();
    const missing: ImportNode = { ...imported, asset: 'gone', name: 'Lost' };
    const answers = await ask({ type: 'build', id: 1, key: geomKey(missing), node: missing }, { type: 'build', id: 2, key: geomKey(box), node: box });
    expect(answers[0].type === 'error' && answers[0].message).toBe('The imported data of "Lost" is missing from this design.');
    expect(answers[1].type).toBe('built');
    expect(await initKernel()).toBe(before);
  });

  it('takes a trap in the WASM or a stray C++ exception for a stopped kernel, and nothing else', () => {
    expect(kernelFault(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
    expect(kernelFault(5247048)).toBe(true);
    expect(kernelFault(new Error('This shape is empty.'))).toBe(false);
    expect(kernelFault(new RangeError('Invalid typed array length'))).toBe(false);
  });

  it('drops the outlines of lettering without throwing away what is built', async () => {
    const { ask } = worker();
    const outline: Asset = { kind: 'outline', shapes: [{ contours: [[[0, 0], [10, 0], [0, 10]]], evenodd: false }] };
    await ask({ type: 'assets', assets: { tetra: solid, 'text:sans:left:"A"': outline } }, { type: 'build', id: 1, key: geomKey(box), node: box });
    const built = cacheSize();
    expect(built).toBeGreaterThan(0);
    await ask({ type: 'forgetAssets', keep: ['tetra'] }, { type: 'measure', id: 2, nodes: [box] });
    expect(assetCount()).toBe(1);
    expect(cacheSize()).toBe(built);
    // Imported data is another matter: what was built from it may be stale.
    await ask({ type: 'forgetAssets', keep: [] }, { type: 'measure', id: 3, nodes: [box] });
    expect(assetCount()).toBe(0);
    expect(cacheSize()).toBe(1);
  });
});

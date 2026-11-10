import { afterAll, describe, expect, it, vi } from 'vitest';
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
    // Only what was built since is cached; the old kernel's solids went with it.
    expect(cacheSize()).toBe(1);
    expect(assetCount()).toBe(1);
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

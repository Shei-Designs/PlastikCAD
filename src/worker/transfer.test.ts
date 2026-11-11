import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build, clearCache, exportColored, exportNodes, forgetAssets, initKernel, robotGeometry, setAssets } from '../geometry/kernel';
import { geomKey } from '../model/geomKey';
import { makeGroup, makeShape } from '../model/ops';
import type { ImportNode } from '../model/types';
import type { WorkerResponse } from './protocol';
import { transferOf } from './transfer';

beforeAll(async () => {
  await initKernel();
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

/** What `postMessage` does with a response: copies it, the listed buffers moved instead. */
const sent = <T extends WorkerResponse>(msg: T): T => structuredClone(msg, { transfer: transferOf(msg) });

describe('what a response hands over', () => {
  it('sends the links of a robot whose open mesh is its own collision shape', () => {
    // A box without its top: 10 triangles, every edge of the rim open.
    const positions = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]);
    const triangles = Uint32Array.from([0, 2, 1, 0, 3, 2, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    setAssets({ tray: { kind: 'mesh', positions: encode(positions), triangles: encode(triangles) } });
    const tray: ImportNode = { id: 'tray', type: 'import', name: 'Tray', asset: 'tray', natural: [10, 10, 10], size: [10, 10, 10], pos: [0, 0, 5], rot: [0, 0, 0], hole: false, color: '#ffffff' };
    const box = { ...makeShape('box'), id: 'box' };
    const result = robotGeometry([tray, box], { tray: 'mesh', box: 'mesh' }, false);
    expect(result[0].props.watertight).toBe(false);
    const msg: WorkerResponse = { type: 'robotGeometry', id: 1, result };
    const list = transferOf(msg);
    expect(new Set(list).size).toBe(list.length);
    const got = sent(msg);
    if (got.type !== 'robotGeometry') throw new Error('unexpected response');
    expect(got.result[0].collision!.triangles.length).toBe(30);
    expect(got.result[0].visual[0].mesh.positions.length).toBe(24);
    expect(got.result[1].collision!.triangles.length).toBe(36);
    // Moved, not copied: the worker's own arrays are empty afterwards.
    expect(result[0].visual[0].mesh.positions.length).toBe(0);
    expect(result[1].collision!.positions.length).toBe(0);
  });

  it('hands over the arrays of a build, an export and a colored export', () => {
    const red = { ...makeShape('box', [-10, 0, 0]), color: '#ff0000' };
    const green = { ...makeShape('cylinder', [10, 0, 0]), color: '#00ff00' };
    const group = makeGroup([red, green], { min: [-20, -10, 0], max: [20, 10, 20] }, 'Pair');
    const built = build(geomKey(group), group);
    const triangles = built.triangles;
    const b = sent({ type: 'built', id: 1, result: built });
    expect(b.result.render.positions.length).toBe(triangles * 9);
    expect(b.result.faces!.source.length).toBe(triangles);
    expect(built.render.positions.length).toBe(0);
    expect(built.render.normals.length).toBe(0);
    expect(built.faces!.source.length).toBe(0);
    const exported = exportNodes([group], false, false, true);
    const e = sent({ type: 'exported', id: 2, result: exported });
    expect(e.result.mesh.triangles.length).toBe(triangles * 3);
    expect(exported.mesh.positions.length).toBe(0);
    expect(exported.faces!.source.length).toBe(0);
    const colored = exportColored([group]);
    const c = sent({ type: 'exportedColored', id: 3, result: colored });
    expect(c.result.objects[0].parts.map((p) => p.color)).toEqual(['#ff0000', '#00ff00']);
    expect(colored.objects[0].parts.every((p) => p.mesh.positions.length === 0 && p.mesh.triangles.length === 0)).toBe(true);
    // And leaves the kernel's cache whole: the same group builds again from it.
    expect(build(geomKey(group), group).render.positions.length).toBe(triangles * 9);
    expect(transferOf({ type: 'measured', id: 4, bounds: null })).toEqual([]);
  });
});

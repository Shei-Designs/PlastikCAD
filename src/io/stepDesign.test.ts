// The design's own objects through the STEP writer and back through the STEP
// reader: every basic shape and a few parts must come back as closed solids
// of the volume and the box the geometry kernel gave them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCache, exportColored, exportNodes, initKernel } from '../geometry/kernel';
import type { MeshData } from '../geometry/mesh';
import { defaultParams, SHAPES } from '../geometry/shapes';
import { makeGroup } from '../model/ops';
import type { PartNode, SceneNode, ShapeNode } from '../model/types';
import { getGenerator } from '../parts/generators';
import { defaultParams as partDefaults } from '../parts/generators/types';
import { parseStep } from './importStep';
import { loadOcc } from './occ';
import { writeStep } from './stepExport';

let oc: OpenCascadeInstance;

beforeAll(async () => {
  await initKernel();
  oc = await loadOcc({ wasmBinary: readFileSync(fileURLToPath(new URL('../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url))) });
}, 60_000);

afterAll(() => clearCache());

const base = { pos: [3, -4, 20] as [number, number, number], rot: [0, 0, 30] as [number, number, number], hole: false, color: '#8fa3bf' };

function volume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [mesh.triangles[t] * 3, mesh.triangles[t + 1] * 3, mesh.triangles[t + 2] * 3];
    sum += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

function box(meshes: MeshData[]): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const mesh of meshes)
    for (let i = 0; i < mesh.positions.length; i++) {
      out[i % 3] = Math.min(out[i % 3], mesh.positions[i]);
      out[3 + (i % 3)] = Math.max(out[3 + (i % 3)], mesh.positions[i]);
    }
  return out;
}

/** Writes the node as the app does, reads the file back, and holds the two against each other. */
function roundTrip(node: SceneNode): void {
  const colored = exportColored([node], true);
  const objects = colored.objects.flatMap((o) => o.parts.map((p) => ({ name: o.name, color: p.color, mesh: p.mesh })));
  const want = exportNodes([node], false, true);
  const { bytes, warnings } = writeStep(oc, objects);
  expect(warnings, node.name).toEqual([]);
  const back = parseStep(oc, bytes, node.name);
  expect(back.parts.length, node.name).toBe(objects.length);
  const total = back.parts.reduce((sum, p) => sum + volume(p.mesh), 0);
  // The same flat faces out and in: the volume to a part in a hundred thousand, the box to a micron.
  expect(Math.abs(total - want.volume) / want.volume, `${node.name}: volume ${total} for ${want.volume}`).toBeLessThan(1e-5);
  const got = box(back.parts.map((p) => p.mesh));
  [...want.bounds.min, ...want.bounds.max].forEach((v, i) => expect(Math.abs(got[i] - v), `${node.name}: box`).toBeLessThan(1e-3));
}

describe('the design as a STEP file', () => {
  for (const def of SHAPES) {
    it(`writes a ${def.kind} that reads back as it was`, () => {
      const node: ShapeNode = { ...base, id: def.kind, name: def.name, type: 'shape', shape: def.kind, params: defaultParams(def.kind), size: def.defaultSize };
      roundTrip(node);
    });
  }

  for (const id of ['spur', 'metric-nut', 'sprocket', 'bearing-seat']) {
    it(`writes a ${id} part that reads back as it was`, () => {
      const def = getGenerator(id);
      const probe: PartNode = { ...base, id, name: def.name, type: 'part', part: id, params: partDefaults(def), natural: [1, 1, 1], size: [1, 1, 1] };
      // At the size its generator makes it.
      const { bounds } = exportNodes([{ ...probe, pos: [0, 0, 0], rot: [0, 0, 0] }], false, true);
      const natural = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]) as [number, number, number];
      roundTrip({ ...probe, natural, size: natural });
    }, 60_000);
  }

  it('writes a plate with a hole through it as one solid, and a two-colored group as a solid per color', () => {
    const plate: ShapeNode = { ...base, id: 'p', name: 'Plate', type: 'shape', shape: 'box', params: defaultParams('box'), size: [40, 30, 4], pos: [0, 0, 2], rot: [0, 0, 0] };
    const hole: ShapeNode = { ...base, id: 'h', name: 'Hole', type: 'shape', shape: 'cylinder', params: defaultParams('cylinder'), size: [8, 8, 10], pos: [5, 3, 2], rot: [0, 0, 0], hole: true };
    roundTrip(makeGroup([plate, hole], { min: [-20, -15, 0], max: [20, 15, 4] }, 'Drilled'));
    const knob: ShapeNode = { ...base, id: 'k', name: 'Knob', type: 'shape', shape: 'cylinder', params: defaultParams('cylinder'), size: [10, 10, 10], pos: [0, 0, 9], rot: [0, 0, 0], color: '#d8605a' };
    const mixed = { ...makeGroup([plate, knob], { min: [-20, -15, 0], max: [20, 15, 14] }, 'Lid'), mixed: true };
    const colored = exportColored([mixed], true);
    expect(colored.objects[0].parts.map((p) => p.color)).toEqual(['#8fa3bf', '#d8605a']);
    roundTrip(mixed);
  });
});

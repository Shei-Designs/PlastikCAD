// The design's own objects through the STEP writer and back through the STEP
// reader: every basic shape and a few parts must come back as closed solids
// of the volume and the box the geometry kernel gave them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCache, exportColored, exportNodes, initKernel, partBox } from '../geometry/kernel';
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

const count = (step: string, entity: string): number => (step.match(new RegExp(`\\b${entity}\\(`, 'g')) ?? []).length;

/**
 * Writes the node as the app does, reads the file back, and holds the two against each other.
 * Answers whether the node went out as true surfaces, and how many faces of each kind the file has.
 */
function roundTrip(node: SceneNode): { exact: boolean; faces: number; planes: number; cylinders: number; cones: number; spheres: number; tori: number } {
  const colored = exportColored([node], true);
  const objects = colored.objects.flatMap((o) => o.parts.map((p) => ({ name: o.name, color: p.color, mesh: p.mesh, ...(o.parts.length === 1 ? { node } : {}) })));
  const want = exportNodes([node], false, true);
  const { bytes, warnings, exact } = writeStep(oc, objects, { partBox });
  expect(warnings, node.name).toEqual([]);
  const back = parseStep(oc, bytes, node.name);
  // An object of several bodies (a cutout with its screw holes) reads back as that many solids.
  expect(back.parts.length, node.name).toBeGreaterThanOrEqual(objects.length);
  const total = back.parts.reduce((sum, p) => sum + volume(p.mesh), 0);
  // The kernel's own facets out and in: the volume to a part in a hundred thousand, the box to a micron. True
  // surfaces read back as finer facets than the kernel's: the volume to half a percent, the box to a twentieth of a millimeter.
  expect(Math.abs(total - want.volume) / want.volume, `${node.name}: volume ${total} for ${want.volume}`).toBeLessThan(exact ? 5e-3 : 1e-5);
  const got = box(back.parts.map((p) => p.mesh));
  [...want.bounds.min, ...want.bounds.max].forEach((v, i) => expect(Math.abs(got[i] - v), `${node.name}: box`).toBeLessThan(exact ? 0.05 : 1e-3));
  const step = new TextDecoder().decode(bytes);
  return {
    exact: exact === 1,
    faces: count(step, 'ADVANCED_FACE'),
    planes: count(step, 'PLANE'),
    cylinders: count(step, 'CYLINDRICAL_SURFACE'),
    cones: count(step, 'CONICAL_SURFACE'),
    spheres: count(step, 'SPHERICAL_SURFACE'),
    tori: count(step, 'TOROIDAL_SURFACE'),
  };
}

describe('the design as a STEP file', () => {
  const shapeNode = (kind: ShapeNode['shape'], over: Partial<ShapeNode> = {}): ShapeNode => {
    const def = SHAPES.find((s) => s.kind === kind)!;
    return { ...base, id: kind, name: def.name, type: 'shape', shape: kind, params: defaultParams(kind), size: def.defaultSize, ...over };
  };

  for (const def of SHAPES) {
    it(`writes a ${def.kind} that reads back as it was`, () => {
      roundTrip(shapeNode(def.kind));
    });
  }

  it('writes the round shapes as the surfaces they are', () => {
    expect(roundTrip(shapeNode('box'))).toMatchObject({ exact: true, faces: 6, planes: 6 });
    // A cylinder: its wall and its two ends.
    expect(roundTrip(shapeNode('cylinder'))).toMatchObject({ exact: true, faces: 3, cylinders: 1, planes: 2 });
    expect(roundTrip(shapeNode('sphere'))).toMatchObject({ exact: true, faces: 1, spheres: 1 });
    expect(roundTrip(shapeNode('cone', { params: { ...defaultParams('cone'), top: 0.5 } }))).toMatchObject({ exact: true, faces: 3, cones: 1, planes: 2 });
    expect(roundTrip(shapeNode('cone', { params: { ...defaultParams('cone'), top: 0 } }))).toMatchObject({ exact: true, faces: 2, cones: 1, planes: 1 });
    expect(roundTrip(shapeNode('torus'))).toMatchObject({ exact: true, faces: 1, tori: 1 });
    // Flat all over: a prism of six sides, a wedge and a roof.
    expect(roundTrip(shapeNode('prism'))).toMatchObject({ exact: true, faces: 8, planes: 8 });
    expect(roundTrip(shapeNode('wedge'))).toMatchObject({ exact: true, faces: 5, planes: 5 });
    expect(roundTrip(shapeNode('roof'))).toMatchObject({ exact: true, faces: 5, planes: 5 });
  });

  it('writes an oval cylinder as an oval, and a cylinder of few sides as the prism it is', () => {
    const oval = roundTrip(shapeNode('cylinder', { size: [30, 20, 10] }));
    expect(oval).toMatchObject({ exact: true, faces: 3, planes: 2, cylinders: 0 });
    const hexagon = roundTrip(shapeNode('cylinder', { params: { ...defaultParams('cylinder'), sides: 6 } }));
    expect(hexagon).toMatchObject({ exact: true, faces: 8, planes: 8 });
  });

  it('rounds a box all over, where flats are left between the rounds', () => {
    const rounded = roundTrip(shapeNode('box', { size: [40, 30, 20], params: { ...defaultParams('box'), radius: 3 } }));
    // Six flats, twelve rounded edges and eight rounded corners.
    expect(rounded).toMatchObject({ exact: true, faces: 26, planes: 6, cylinders: 12, spheres: 8 });
  });

  it('falls back on the facets for what has no simple surface, and still writes it true to size', () => {
    // A ball squeezed into an egg, a mirrored wedge turned off the axes, a dome.
    expect(roundTrip(shapeNode('sphere', { size: [20, 20, 30] })).exact).toBe(false);
    expect(roundTrip(shapeNode('dome')).exact).toBe(false);
    expect(roundTrip(shapeNode('wedge', { flip: [true, false, false], rot: [10, 20, 30] })).exact).toBe(true);
  });

  const partNode = (id: string, params: Record<string, number | string | boolean> = {}): PartNode => {
    const def = getGenerator(id);
    const probe: PartNode = { ...base, id, name: def.name, type: 'part', part: id, params: { ...partDefaults(def), ...params }, natural: [1, 1, 1], size: [1, 1, 1] };
    // At the size its generator makes it.
    const { bounds } = exportNodes([{ ...probe, pos: [0, 0, 0], rot: [0, 0, 0] }], false, true);
    const natural = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]) as [number, number, number];
    return { ...probe, natural, size: natural };
  };

  for (const id of ['spur', 'metric-nut', 'sprocket', 'bearing-seat', 'screw-hole', 'gt2-pulley']) {
    it(`writes a ${id} part that reads back as it was`, () => {
      roundTrip(partNode(id));
    }, 120_000);
  }

  it('writes a part from its description where that is profiles and round bores, and from its facets where it is twisted', () => {
    // A bearing seat: two bores, one on the other.
    expect(roundTrip(partNode('bearing-seat'))).toMatchObject({ exact: true, cylinders: 2 });
    // A threaded nut is a twisted extrusion: no exact form.
    expect(roundTrip(partNode('metric-nut')).exact).toBe(false);
    // Flat profiles with round holes: a gear, a pulley, a motor mount, a panel cutout, a board.
    for (const id of ['spur', 'gt2-pulley', 'stepper-mount', 'panel-connector', 'raspberry-pi', 'extrusion']) expect(roundTrip(partNode(id)).exact, id).toBe(true);
    // An outline that crosses itself (the servo's body cut through the edge of its plate) is left to the facets.
    expect(roundTrip(partNode('servo-mount')).exact).toBe(false);
  }, 120_000);

  it('writes a plate with a hole through it as one solid, and a two-colored group as a solid per color', () => {
    const plate: ShapeNode = { ...base, id: 'p', name: 'Plate', type: 'shape', shape: 'box', params: defaultParams('box'), size: [40, 30, 4], pos: [0, 0, 2], rot: [0, 0, 0] };
    const hole: ShapeNode = { ...base, id: 'h', name: 'Hole', type: 'shape', shape: 'cylinder', params: defaultParams('cylinder'), size: [8, 8, 10], pos: [5, 3, 2], rot: [0, 0, 0], hole: true };
    // The plate's six sides and the wall of the hole: seven faces, one of them a cylinder.
    expect(roundTrip(makeGroup([plate, hole], { min: [-20, -15, 0], max: [20, 15, 4] }, 'Drilled'))).toMatchObject({ exact: true, faces: 7, planes: 6, cylinders: 1 });
    const knob: ShapeNode = { ...base, id: 'k', name: 'Knob', type: 'shape', shape: 'cylinder', params: defaultParams('cylinder'), size: [10, 10, 10], pos: [0, 0, 9], rot: [0, 0, 0], color: '#d8605a' };
    const mixed = { ...makeGroup([plate, knob], { min: [-20, -15, 0], max: [20, 15, 14] }, 'Lid'), mixed: true };
    const colored = exportColored([mixed], true);
    expect(colored.objects[0].parts.map((p) => p.color)).toEqual(['#8fa3bf', '#d8605a']);
    roundTrip(mixed);
  });
});

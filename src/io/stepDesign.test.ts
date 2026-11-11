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
import { boxSlack, exactShape } from './stepExact';
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
function roundTrip(node: SceneNode, asShown = false, slack = 5e-3): { exact: boolean; bytes: Uint8Array; solids: number; faces: number; planes: number; cylinders: number; cones: number; spheres: number; tori: number; splines: number } {
  const colored = exportColored([node], true);
  // As the app writes it: what cannot be rebuilt goes out with the facets the screen has, not the finest.
  const shown = asShown ? exportColored([node], false) : null;
  const objects = colored.objects.flatMap((o, i) => o.parts.map((p, k) => ({ name: o.name, color: p.color, mesh: p.mesh, ...(shown ? { facets: shown.objects[i].parts[k].mesh } : {}), ...(o.parts.length === 1 ? { node } : {}) })));
  const { bytes, warnings, exact } = writeStep(oc, objects, { partBox });
  // What was rebuilt is held against the finest facets, as the writer held it; what went out as the screen's facets, against those.
  const want = exportNodes([node], false, !asShown || exact > 0);
  expect(warnings, node.name).toEqual([]);
  const back = parseStep(oc, bytes, node.name);
  // An object of several bodies (a cutout with its screw holes) reads back as that many solids.
  expect(back.parts.length, node.name).toBeGreaterThanOrEqual(objects.length);
  const total = back.parts.reduce((sum, p) => sum + volume(p.mesh), 0);
  // The kernel's own facets out and in: the volume to a part in a hundred thousand, the box to a micron. True
  // surfaces read back as finer facets than the kernel's: the volume to half a percent (`slack`), the box to what a curve stands out from its facets.
  expect(Math.abs(total - want.volume) / want.volume, `${node.name}: volume ${total} for ${want.volume}`).toBeLessThan(exact ? slack : 1e-5);
  const got = box(back.parts.map((p) => p.mesh));
  [...want.bounds.min, ...want.bounds.max].forEach((v, i) => expect(Math.abs(got[i] - v), `${node.name}: box`).toBeLessThan(exact ? boxSlack(want.bounds) : 1e-3));
  const step = new TextDecoder().decode(bytes);
  return {
    exact: exact === 1,
    bytes,
    solids: count(step, 'MANIFOLD_SOLID_BREP'),
    faces: count(step, 'ADVANCED_FACE'),
    planes: count(step, 'PLANE'),
    cylinders: count(step, 'CYLINDRICAL_SURFACE'),
    cones: count(step, 'CONICAL_SURFACE'),
    spheres: count(step, 'SPHERICAL_SURFACE'),
    tori: count(step, 'TOROIDAL_SURFACE'),
    splines: count(step, 'B_SPLINE_SURFACE_WITH_KNOTS'),
  };
}

/** What OpenCascade makes of a STEP file read back: how many solids, whether it finds no fault in them, and whether every skin is closed. */
function inspect(bytes: Uint8Array): { solids: number; valid: boolean; closed: boolean } {
  const path = '/inspect.step';
  oc.FS.writeFile(path, bytes);
  const reader = new oc.STEPControl_Reader();
  const progress = new oc.Message_ProgressRange();
  try {
    expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
    reader.TransferRoots(progress);
    const shape = reader.OneShape();
    const each = (kind: (typeof oc.TopAbs_ShapeEnum)[keyof typeof oc.TopAbs_ShapeEnum], visit: (s: InstanceType<typeof oc.TopoDS_Shape>) => void): void => {
      const explorer = new oc.TopExp_Explorer(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; explorer.More(); explorer.Next()) visit(explorer.Current());
      explorer.delete();
    };
    let solids = 0;
    each(oc.TopAbs_ShapeEnum.TopAbs_SOLID, () => solids++);
    let closed = true;
    each(oc.TopAbs_ShapeEnum.TopAbs_SHELL, (s) => {
      if (!oc.TopoDS.Shell(s).Closed()) closed = false;
    });
    const checker = new oc.BRepCheck_Analyzer(shape, true, false, false);
    const valid = checker.IsValid();
    checker.delete();
    shape.delete();
    return { solids, valid, closed };
  } finally {
    reader.delete();
    progress.delete();
    oc.FS.unlink(path);
  }
}

describe('the design as a STEP file', () => {
  const shapeNode = (kind: ShapeNode['shape'], over: Partial<ShapeNode> = {}): ShapeNode => {
    const def = SHAPES.find((s) => s.kind === kind)!;
    return { ...base, id: kind, name: def.name, type: 'shape', shape: kind, params: defaultParams(kind), size: def.defaultSize, ...over };
  };

  // A fillet is a sliver of a bar: the reader's facets across its hollow, each within its fiftieth of a
  // millimeter of the curve, add more to so little than half a percent.
  const FILLET = 0.025;

  for (const def of SHAPES) {
    it(`writes a ${def.kind} that reads back as it was`, () => {
      roundTrip(shapeNode(def.kind), false, def.kind === 'fillet' ? FILLET : undefined);
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
    // A ball squeezed into an egg, a dome taller than half a ball or deeper than wide, an oval cone.
    expect(roundTrip(shapeNode('sphere', { size: [20, 20, 30] })).exact).toBe(false);
    expect(roundTrip(shapeNode('dome', { size: [20, 20, 15] })).exact).toBe(false);
    expect(roundTrip(shapeNode('dome', { size: [30, 20, 10] })).exact).toBe(false);
    expect(roundTrip(shapeNode('cone', { size: [30, 20, 20] })).exact).toBe(false);
    // A round roof of three steps is flat faces, and a fillet of one step a chamfer.
    expect(roundTrip(shapeNode('roundroof', { params: { ...defaultParams('roundroof'), sides: 3 } })).exact).toBe(false);
    expect(roundTrip(shapeNode('fillet', { params: { ...defaultParams('fillet'), sides: 1 } })).exact).toBe(false);
    expect(roundTrip(shapeNode('wedge', { flip: [true, false, false], rot: [10, 20, 30] })).exact).toBe(true);
  });

  it('writes a round roof or a fillet stretched out of round as the oval bar it has become', () => {
    // A round roof taller or flatter than half a round bar: half an oval bar, with its flat and its ends.
    expect(roundTrip(shapeNode('roundroof', { size: [20, 20, 15] }))).toMatchObject({ exact: true, faces: 4, planes: 3, cylinders: 0 });
    expect(roundTrip(shapeNode('roundroof', { size: [40, 20, 6], rot: [0, 90, 20] }))).toMatchObject({ exact: true, faces: 4, planes: 3 });
    // A fillet wider than tall, or taller than wide.
    expect(roundTrip(shapeNode('fillet', { size: [8, 20, 5] }), false, FILLET)).toMatchObject({ exact: true, faces: 5, planes: 4, cylinders: 0 });
    expect(roundTrip(shapeNode('fillet', { size: [4, 20, 9], flip: [false, false, true] }), false, FILLET)).toMatchObject({ exact: true, faces: 5, planes: 4 });
  });

  it('writes a dome, a round roof and a fillet as the round surfaces they are, while they are not stretched', () => {
    // Half a ball: its skin and its flat.
    expect(roundTrip(shapeNode('dome'))).toMatchObject({ exact: true, faces: 2, spheres: 1, planes: 1 });
    // Half a round bar: its back, its flat and its two ends.
    expect(roundTrip(shapeNode('roundroof'))).toMatchObject({ exact: true, faces: 4, cylinders: 1, planes: 3 });
    // A fillet: its hollow, its two flats and its two ends.
    expect(roundTrip(shapeNode('fillet'), false, FILLET)).toMatchObject({ exact: true, faces: 5, cylinders: 1, planes: 4 });
    // Longer, turned over and off the axes, they are the same surfaces.
    expect(roundTrip(shapeNode('roundroof', { size: [20, 60, 10], rot: [90, 20, 0] }))).toMatchObject({ exact: true, cylinders: 1 });
    expect(roundTrip(shapeNode('fillet', { size: [5, 40, 5], flip: [true, false, false] }), false, FILLET)).toMatchObject({ exact: true, cylinders: 1 });
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

  it('writes a part from its description where that is profiles and round bores, and from its facets where it is threaded', () => {
    // A bearing seat: two bores, one on the other.
    expect(roundTrip(partNode('bearing-seat'))).toMatchObject({ exact: true, cylinders: 2 });
    // A threaded nut: its thread is a coil of facets cut to length, which has no exact form.
    expect(roundTrip(partNode('metric-nut')).exact).toBe(false);
    // Flat profiles with round holes: a gear, a pulley, a motor mount, a panel cutout, a board.
    for (const id of ['spur', 'gt2-pulley', 'stepper-mount', 'servo-mount', 'panel-connector', 'raspberry-pi', 'extrusion']) expect(roundTrip(partNode(id)).exact, id).toBe(true);
  }, 120_000);

  // A thread is a coil cut to length: its mesh has corners that are one place under two numbers by
  // the thousand, triangles of no area between them, and a few whose corners lie in a line.
  for (const id of ['metric-bolt', 'lead-screw', 'lead-screw-nut', 'worm']) {
    it(`writes a ${id} as one closed solid of its facets, as the app exports it`, () => {
      const written = roundTrip(partNode(id), true);
      expect(written.exact).toBe(false);
      expect(written.faces).toBeGreaterThan(1000);
    }, 120_000);
  }

  describe('gears with teeth that wind', () => {
    // Each with the number of its teeth. A tooth is some seventeen faces up each stage of the gear, as the tracer reads
    // its outline (the flanks in a few arcs each, the tip, the root); never two dozen, where its facets are hundreds.
    const gears: [string, string, Record<string, number | string | boolean>, number][] = [
      ['helical', 'at its defaults', {}, 24],
      // Turned by more than a quarter turn over its height.
      ['helical', 'of few teeth at a steep angle', { teeth: 12, faceWidth: 30, helixAngle: 45 }, 12],
      ['helical', 'left-handed', { hand: 'left' }, 24],
      ['helical', 'with a hub, two set screws and a D bore', { hubHeight: 8, setScrews: 2, boreType: 'd' }, 24],
      // Two halves that wind opposite ways: every tooth twice.
      ['herringbone', 'at its defaults', {}, 48],
    ];
    for (const [id, what, params, teeth] of gears) {
      it(`writes a ${id} gear ${what} as one solid of smooth faces`, () => {
        // As the app exports it: were it not rebuilt, the screen's facets would go out, and `exact` would say so.
        const written = roundTrip(partNode(id, params), true);
        expect(written.exact).toBe(true);
        expect(written.solids).toBe(1);
        // Every side of the outline a face of its own, swept up the helix; the two ends, the bore and what a hub adds.
        expect(written.splines).toBeGreaterThanOrEqual(teeth * 4);
        expect(written.faces).toBeLessThanOrEqual(teeth * 24);
        expect(inspect(written.bytes)).toEqual({ solids: 1, valid: true, closed: true });
      }, 120_000);
    }

    // The volume and the box cannot tell a gear from its mirror image, nor a herringbone from a helical gear of the
    // same teeth: the corners of the kernel's finest facets can, which all lie on the skin of the true solid.
    const wound: [string, string, Record<string, number | string | boolean>][] = [
      ['helical', 'at its defaults', {}],
      ['helical', 'left-handed', { hand: 'left', helixAngle: 35 }],
      ['herringbone', 'at its defaults', {}],
    ];
    for (const [id, what, params] of wound) {
      it(`rebuilds a ${id} gear ${what} through the corners of the kernel's own`, () => {
        const node = partNode(id, params);
        const fine = exportColored([node], true).objects[0].parts[0].mesh;
        const [x0, y0, z0, x1, y1, z1] = box([fine]);
        const made: { delete(): void }[] = [];
        const keep = <T extends { delete(): void }>(o: T): T => {
          made.push(o);
          return o;
        };
        try {
          const shape = exactShape(oc, node, { volume: volume(fine), bounds: { min: [x0, y0, z0], max: [x1, y1, z1] } }, { partBox }, keep);
          if (!shape) throw new Error(`${id}: not rebuilt`);
          expect(keep(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid()).toBe(true);
          const skin = keep(keep(new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE)).Current());
          const corners = fine.positions.length / 3;
          const picks = 150;
          let worst = 0;
          for (let k = 0; k < picks; k++) {
            const i = Math.floor(((k + 0.5) / picks) * corners);
            const corner = keep(keep(new oc.BRepBuilderAPI_MakeVertex(keep(new oc.gp_Pnt(fine.positions[i * 3], fine.positions[i * 3 + 1], fine.positions[i * 3 + 2])))).Vertex());
            worst = Math.max(worst, keep(new oc.BRepExtrema_DistShapeShape(corner, skin)).Value());
          }
          // A hundredth of a millimeter: five times what the tracer lets a corner stand off the arc it reads it on.
          expect(worst).toBeLessThan(0.01);
        } finally {
          for (const o of made.reverse()) {
            try {
              o.delete();
            } catch {
              // Already let go with what held it.
            }
          }
        }
      }, 120_000);
    }
  });

  it('writes a V-belt pulley as the cones of its groove between the cylinders of its rim', () => {
    // The rim either side of the groove and the groove's floor; its two flanks; the two sides; and the bore.
    expect(roundTrip(partNode('v-belt-pulley'))).toMatchObject({ exact: true, cones: 2, cylinders: 4, planes: 2 });
  });

  describe('pipes and ducts', () => {
    it('writes a straight pipe as two cylinders, one inside the other, and a solid one as one', () => {
      // The outer wall, the bore and the two ring-shaped ends.
      expect(roundTrip(partNode('pipe'))).toMatchObject({ exact: true, faces: 4, cylinders: 2, planes: 2 });
      expect(roundTrip(partNode('pipe', { wall: 0 }))).toMatchObject({ exact: true, faces: 3, cylinders: 1, planes: 2 });
    });

    it('writes a rectangular duct as flats and rounded corners', () => {
      // Four flats and four corners outside, the same inside, and two ends.
      expect(roundTrip(partNode('pipe', { section: 'rect' }))).toMatchObject({ exact: true, faces: 18, planes: 10, cylinders: 8 });
      expect(roundTrip(partNode('pipe', { section: 'rect', corner: 0, wall: 0 }))).toMatchObject({ exact: true, faces: 6, planes: 6 });
    });

    it('writes an elbow as a bend between two straight legs', () => {
      // Outside and bore: a torus for the bend and a cylinder for each leg; and the two ends.
      expect(roundTrip(partNode('elbow'))).toMatchObject({ exact: true, tori: 2, cylinders: 4, planes: 2 });
      // Without legs, solid, at another angle: the bend alone.
      expect(roundTrip(partNode('elbow', { legA: 0, legB: 0, wall: 0, angle: 45 }))).toMatchObject({ exact: true, tori: 1, cylinders: 0, planes: 2 });
      // Hollow and without legs: the bore runs straight out through each end, which leaves the bend the bend it is.
      expect(roundTrip(partNode('elbow', { legA: 0, legB: 0 }))).toMatchObject({ exact: true, tori: 2, cylinders: 0, planes: 2 });
      // A rectangular one bends in cylinders, flat rings and, round its corners, tori.
      const duct = roundTrip(partNode('elbow', { section: 'rect', angle: 120 }));
      expect(duct.exact).toBe(true);
      expect(duct.tori).toBe(8);
    }, 120_000);

    it('writes a reducer as a cone, and one off its axis or between rectangles as straight lines from end to end', () => {
      expect(roundTrip(partNode('reducer'))).toMatchObject({ exact: true, cones: 2, planes: 2 });
      expect(roundTrip(partNode('reducer', { offset: 4.5 })).exact).toBe(true);
      expect(roundTrip(partNode('reducer', { section: 'rect' })).exact).toBe(true);
    }, 120_000);

    it('writes a tee as two pipes run together, square or leaning', () => {
      expect(roundTrip(partNode('tee')).exact).toBe(true);
      expect(roundTrip(partNode('tee', { branchAngle: 45, diameter2: 16 })).exact).toBe(true);
      expect(roundTrip(partNode('tee', { section: 'rect' })).exact).toBe(true);
    }, 120_000);
  });

  it('writes names and colors that come back with the solids they are of', () => {
    const named = (kind: ShapeNode['shape'], name: string, color: string, x: number): ShapeNode => ({ ...shapeNode(kind), id: name, name, color, pos: [x, 5, 20] });
    // Two of one name, a name with a quote in it and one with letters outside ASCII; rebuilt solids and one of facets.
    const nodes = [named('box', 'Base plate', '#11aa33', 0), named('cylinder', 'Shaft', '#cc2211', 40), named('sphere', 'Shaft', '#cc2211', 80), named('torus', "Ring 'o' été", '#2244ee', 120), named('pyramid', 'Roof', '#f0c000', 160)];
    const colored = exportColored(nodes, true);
    const { bytes } = writeStep(oc, colored.objects.flatMap((o, i) => o.parts.map((p) => ({ name: o.name, color: p.color, mesh: p.mesh, node: nodes[i] }))), { partBox });
    expect(parseStep(oc, bytes, 'file').parts.map((p) => [p.name, p.color])).toEqual([
      ['Base plate', '#11aa33'],
      ['Shaft 1', '#cc2211'],
      ['Shaft 2', '#cc2211'],
      ["Ring 'o' été", '#2244ee'],
      ['Roof', '#f0c000'],
    ]);
  });

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

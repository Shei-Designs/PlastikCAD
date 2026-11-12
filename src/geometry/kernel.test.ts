import { CURVED_TRIANGLES, curvedSize } from '../text/curve';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { geomKey, textAssetKey } from '../model/geomKey';
import { add, apply, emptyBounds, expandBounds, nodeMatrix } from '../model/math';
import type { Bounds } from '../model/math';
import { alignNodes, cloneNode, makeGroup, sourceColor } from '../model/ops';
import type { Asset, GroupNode, ImportNode, PictureNode, Polygon, SceneNode, ShapeKind, ShapeNode, TextNode, Vec3 } from '../model/types';
import { traceArcs } from '../io/arcs';
import { getGenerator } from '../parts/generators';
import { castRay } from './bvh';
import { build, cacheSize, clearCache, decodeBase64, exportColored, exportNodes, forgetAssets, initKernel, measure, partBox, rawManifold, SHEET, setAssets } from './kernel';
import type { MeshData } from './mesh';
import { meshProperties } from '../robot/inertia';
import { defaultParams, shapeDef } from './shapes';

import type { ManifoldToplevel } from 'manifold-3d';

let k: ManifoldToplevel;

beforeAll(async () => {
  k = await initKernel();
});

afterAll(() => clearCache());

let nextId = 1;

const base = (name: string) => ({
  id: `n${nextId++}`,
  name,
  pos: [0, 0, 0] as Vec3,
  rot: [0, 0, 0] as Vec3,
  hole: false,
  color: '#8fa3bf',
});

function shape(kind: ShapeKind, over: Partial<ShapeNode> = {}): ShapeNode {
  const def = shapeDef(kind);
  return { ...base(def.name), type: 'shape', shape: kind, params: defaultParams(kind), size: def.defaultSize, ...over };
}

/** A group at its natural size unless told otherwise. */
function group(natural: Vec3, children: SceneNode[], over: Partial<GroupNode> = {}): GroupNode {
  return { ...base('Group'), type: 'group', natural, size: natural, children, ...over };
}

function imported(asset: string, natural: Vec3, over: Partial<ImportNode> = {}): ImportNode {
  return { ...base(asset), type: 'import', asset, natural, size: natural, ...over };
}

const make = (node: SceneNode) => build(geomKey(node), node);

/** Area of a regular polygon with `n` sides around a circle of radius `r` (how cylinders are built). */
const around = (n: number, r: number) => n * Math.tan(Math.PI / n) * r * r;

function expectBounds(b: { min: Vec3; max: Vec3 } | null, min: Vec3, max: Vec3, digits = 3): void {
  expect(b).not.toBeNull();
  for (let i = 0; i < 3; i++) {
    expect(b!.min[i]).toBeCloseTo(min[i], digits);
    expect(b!.max[i]).toBeCloseTo(max[i], digits);
  }
}

/** Base64 of a typed array's bytes, as design files store mesh assets. */
function encode(a: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const meshAsset = (positions: number[], triangles: number[]): Asset => ({
  kind: 'mesh',
  positions: encode(Float32Array.from(positions)),
  triangles: encode(Uint32Array.from(triangles)),
});

// A 2 mm cube centered on the origin; vertex i sits at (bit 0, bit 1, bit 2) of i. Outward-facing triangles.
const CUBE_POSITIONS = Array.from({ length: 8 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]).flat();
// prettier-ignore
const CUBE_TRIANGLES = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6,
  0, 1, 5, 0, 5, 4, 2, 7, 3, 2, 6, 7,
  0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5,
];

/** Six times the volume enclosed by a mesh; its sign tells which way the triangles face. */
function signedVolume({ positions: p, triangles: t }: MeshData): number {
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v;
}

function area(contours: Polygon[]): number {
  let a = 0;
  for (const poly of contours) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % poly.length];
      a += (x0 * y1 - x1 * y0) / 2;
    }
  }
  return a;
}

const drilled = (): GroupNode =>
  group([20, 20, 20], [shape('box'), shape('cylinder', { size: [10, 10, 30], hole: true })]);
const DRILLED_VOLUME = 8000 - around(64, 5) * 20;

describe('groups', () => {
  it('cuts holes out of solids', () => {
    const r = make(drilled());
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(DRILLED_VOLUME, 3);
    expectBounds(r.bounds, [-10, -10, -10], [10, 10, 10]);
    expect(r.render.positions.length).toBe(r.triangles * 9);
  });

  it('merges overlapping solids', () => {
    const r = make(group([30, 20, 20], [shape('box', { pos: [-5, 0, 0] }), shape('box', { pos: [5, 0, 0] })]));
    expect(r.volume).toBeCloseTo(30 * 20 * 20, 6);
    expectBounds(r.bounds, [-15, -10, -10], [15, 10, 10]);
  });

  it('builds nested groups, scaled and turned', () => {
    // The drilled block stretched to twice its length and turned to lie along Y.
    const inner: GroupNode = { ...drilled(), size: [40, 20, 20], rot: [0, 0, 90], pos: [0, 50, 0] };
    const r = make(group([20, 75, 20], [inner, shape('box', { size: [10, 10, 10] })]));
    expect(r.volume).toBeCloseTo(2 * DRILLED_VOLUME + 1000, 3);
    expectBounds(r.bounds, [-10, -5, -10], [10, 70, 10]);
  });

  it('lets a hole inside a nested group cut only that group', () => {
    const plate = shape('box', { size: [40, 40, 2], pos: [0, 0, 0] });
    const r = make(group([40, 40, 20], [plate, drilled()]));
    // The plate is not drilled: it closes the bore where it passes through.
    expect(r.volume).toBeCloseTo(DRILLED_VOLUME + 40 * 40 * 2 - 20 * 20 * 2 + around(64, 5) * 2, 3);
  });

  it('mirrors children', () => {
    // Removing the -X half of a wedge leaves a quarter of it, or three quarters once it is mirrored.
    const cut = shape('box', { size: [10, 20, 20], pos: [-5, 0, 0], hole: true });
    const plain = make(group([10, 20, 20], [shape('wedge'), cut]));
    const flipped = make(group([10, 20, 20], [shape('wedge', { flip: [true, false, false] }), cut]));
    expect(plain.volume).toBeCloseTo(1000, 6);
    expect(flipped.volume).toBeCloseTo(3000, 6);
    // Mirrored and turned, as a hole: the kernel must keep it the right way out for the cut to work.
    const hole = shape('wedge', { flip: [false, false, true], rot: [0, 0, 180], hole: true });
    const r = make(group([20, 20, 20], [shape('box'), hole]));
    expect(r.volume).toBeCloseTo(4000, 6);
    // What is left is full height at -X and nothing at +X, underside sloping.
    const half = shape('box', { size: [10, 20, 20], pos: [5, 0, 0], hole: true });
    const left = make(group([10, 20, 20], [shape('box'), hole, half]));
    expect(left.volume).toBeCloseTo(3000, 6);
  });

  it('scales children unevenly', () => {
    const r = make(group([20, 10, 40], [shape('sphere', { size: [20, 10, 40] })]));
    const exact = (4 / 3) * Math.PI * 10 * 5 * 20;
    expect(Math.abs(r.volume / exact - 1)).toBeLessThan(0.02);
    expectBounds(r.bounds, [-10, -5, -20], [10, 5, 20]);
  });

  it('counts hidden children', () => {
    const drill = shape('cylinder', { size: [10, 10, 30], hole: true, hidden: true });
    const r = make(group([20, 20, 20], [shape('box'), drill]));
    expect(r.volume).toBeCloseTo(DRILLED_VOLUME, 3);
  });

  it('explains a group with nothing left', () => {
    expect(() => make(group([20, 20, 20], [shape('box', { hole: true })]))).toThrow(/only contains holes/);
    const all = group([20, 20, 20], [shape('box'), shape('box', { size: [30, 30, 30], hole: true })]);
    expect(() => make(all)).toThrow(/holes remove everything/);
  });
});

describe('pictures', () => {
  const picture = (over: Partial<PictureNode> = {}): PictureNode => ({ ...base('Picture'), type: 'picture', asset: 'img', mapping: 'flat', angle: 120, natural: [1, 1, 1], size: [40, 20, 1], ...over });

  it('builds a flat picture as a thin unit sheet and a wrapped one as a band', () => {
    const flat = make(picture());
    expectBounds(flat.bounds, [-0.5, -0.5, -SHEET / 2], [0.5, 0.5, SHEET / 2]);
    expect(flat.volume).toBeCloseTo(SHEET, 6);
    const band = make(picture({ mapping: 'wrap', angle: 180 }));
    // Half a ring of radius 1/2, SHEET thick, facing the front: the full way across X, from the axis to -Y.
    expectBounds(band.bounds, [-0.5, -0.5, -0.5], [0.5, 0, 0.5], 2);
    expect(band.volume).toBeCloseTo((Math.PI / 2) * (0.25 - (0.5 - SHEET) ** 2), 2);
    const full = make(picture({ mapping: 'wrap', angle: 360 }));
    expect(full.volume).toBeCloseTo(Math.PI * (0.25 - (0.5 - SHEET) ** 2), 2);
  });

  it('leaves the solid of a group alone and stays out of its measure and its export', () => {
    const plain = make(drilled());
    const g = drilled();
    g.children.push(picture({ pos: [0, -12, 0], rot: [90, 0, 0] }));
    const withPicture = make(g);
    expect(withPicture.volume).toBeCloseTo(plain.volume, 6);
    expectBounds(withPicture.bounds, [-10, -10, -10], [10, 10, 10]);
    expectBounds(measure(g.children), [-10, -10, -10], [10, 10, 10]);
    // A lone picture is nothing to export; alongside a solid it is simply left out.
    expect(() => exportNodes([picture()], false)).toThrow(/nothing to export/);
    expect(exportNodes([g, picture()], false).volume).toBeCloseTo(plain.volume, 6);
    // Except in its own frame, where its sheet is what a GLB shows.
    expect(exportNodes([picture()], false, false, true).volume).toBeCloseTo(SHEET, 6);
  });
});

describe('measure', () => {
  it('gives the tight bounds of what is left', () => {
    const box = shape('box');
    const drill = shape('cylinder', { size: [10, 10, 60], hole: true });
    expectBounds(measure([box, drill]), [-10, -10, -10], [10, 10, 10]);
    // The same cylinder as a solid does stick out.
    expectBounds(measure([box, { ...drill, hole: false }]), [-10, -10, -30], [10, 10, 30]);
    // A hole that takes a whole end off makes the result shorter.
    const end = shape('box', { size: [10, 30, 30], pos: [8, 0, 0], hole: true });
    expectBounds(measure([box, end]), [-10, -10, -10], [3, 10, 10]);
  });

  it('follows rotation instead of boxing the box', () => {
    const b = measure([shape('cylinder', { rot: [0, 0, 30], pos: [100, 0, 0] })])!;
    expect(b.max[0] - b.min[0]).toBeLessThan(20.05);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(19.99);
    const tilted = measure([shape('box', { rot: [0, 0, 45] })])!;
    expect(tilted.max[0]).toBeCloseTo(10 * Math.SQRT2, 6);
  });

  it('counts hidden nodes, which a group takes in and shows, and reports nothing as null', () => {
    const box = shape('box');
    const far = shape('box', { pos: [40, 0, 0], hidden: true });
    expectBounds(measure([box, far]), [-10, -10, -10], [50, 10, 10]);
    expectBounds(measure([far]), [30, -10, -10], [50, 10, 10]);
    // A hidden hole cuts all the same.
    const end = shape('box', { size: [10, 30, 30], pos: [8, 0, 0], hole: true, hidden: true });
    expectBounds(measure([box, end]), [-10, -10, -10], [3, 10, 10]);
    // The group made of them has the box of what it builds.
    const g = makeGroup([box, far], measure([box, far])!, 'Group');
    expect(g.children.some((c) => c.hidden)).toBe(false);
    expect(g.size).toEqual([60, 20, 20]);
    const built = make(g).bounds;
    expectBounds(built, [-g.size[0] / 2, -g.size[1] / 2, -g.size[2] / 2], [g.size[0] / 2, g.size[1] / 2, g.size[2] / 2]);
    expect(measure([])).toBeNull();
    expect(measure([shape('box', { hole: true })])).toBeNull();
    expect(measure([box, shape('box', { size: [30, 30, 30], hole: true })])).toBeNull();
  });
});

describe('hole groups', () => {
  it('cuts as one when a group of holes is itself a hole', () => {
    // A cut-out and two screw holes, kept together as one template.
    const slot = shape('box', { size: [20, 10, 30] });
    const left = shape('cylinder', { size: [3, 3, 30], pos: [-14, 0, 0] });
    const right = shape('cylinder', { size: [3, 3, 30], pos: [14, 0, 0] });
    const template = makeGroup([slot, left, right], measure([slot, left, right])!, 'XLR', { hole: true });
    expect(template.hole).toBe(true);
    const panel = shape('box', { size: [60, 40, 3] });
    const cut = makeGroup([panel, template], measure([panel, template])!, 'Panel');
    const v = build(geomKey(cut), cut).volume;
    const bores = 2 * around(64, 1.5) * 3;
    expect(v).toBeCloseTo(60 * 40 * 3 - 20 * 10 * 3 - bores, 3);
  });
});

describe('the parts a group was made from', () => {
  /** The ids of the parts along a path of places (see `Faces`). */
  const idsAlong = (node: SceneNode, path: number[]): string[] => {
    const ids: string[] = [];
    let nodes = node.type === 'group' ? node.children : [];
    for (const place of path) {
      const part = nodes.filter((n) => n.type !== 'picture')[place];
      ids.push(part.id);
      nodes = part.type === 'group' ? part.children : [];
    }
    return ids;
  };

  /** How many triangles of the result each source part made, by the ids along its path. */
  const share = (node: SceneNode): Record<string, number> => {
    const faces = make(node).faces!;
    const out: Record<string, number> = {};
    for (const s of faces.source) {
      const key = s === 0xffff ? '?' : idsAlong(node, faces.sources[s]).join('/');
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  /** How many triangles of the result show each color. */
  const colors = (node: GroupNode): Record<string, number> => {
    const faces = make(node).faces!;
    const out: Record<string, number> = {};
    for (const s of faces.source) {
      const color = s === 0xffff ? '?' : sourceColor(node, faces.sources[s]);
      out[color] = (out[color] ?? 0) + 1;
    }
    return out;
  };

  const twoTone = (): GroupNode => {
    const box = shape('box', { pos: [-10, 0, 10], color: '#ff0000' });
    const rod = shape('cylinder', { pos: [10, 0, 10], color: '#00ff00' });
    return makeGroup([box, rod], measure([box, rod])!, 'Two-tone');
  };

  it('tells which part made each face, through a union and a cut', () => {
    const left = shape('box', { id: 'L', size: [20, 20, 20], pos: [-10, 0, 10] });
    const right = shape('box', { id: 'R', size: [20, 20, 20], pos: [10, 0, 10] });
    const bore = shape('cylinder', { id: 'B', size: [8, 8, 30], pos: [10, 0, 10], hole: true });
    const g = makeGroup([left, right, bore], measure([left, right, bore])!, 'Pair');
    const got = share(g);
    expect(Object.keys(got).sort()).toEqual(['B', 'L', 'R']);
    // The bore's wall is the only thing the hole contributes; the two boxes keep their outsides.
    expect(got.B).toBeGreaterThanOrEqual(64 * 2);
    expect(got.L).toBeGreaterThanOrEqual(10);
    expect(got.R).toBeGreaterThanOrEqual(10);
    expect(make(g).faces!.source.length).toBe(make(g).render.positions.length / 9);
  });

  it('tells the parts of a group inside a group apart, all the way down', () => {
    const a = shape('box', { id: 'A', size: [10, 10, 10], pos: [-5, 0, 5] });
    const b = shape('sphere', { id: 'Bs', size: [10, 10, 10], pos: [5, 0, 5] });
    const inner = makeGroup([a, b], measure([a, b])!, 'Inner');
    const c = shape('box', { id: 'C', size: [10, 10, 10], pos: [20, 0, 5] });
    const mixed = makeGroup([inner, c], measure([inner, c])!, 'Outer');
    expect(Object.keys(share(mixed)).sort()).toEqual(['C', `${inner.id}/A`, `${inner.id}/Bs`].sort());
    // Whether the inner group is painted is for the viewer to settle; the kernel's answer is the same.
    const painted = makeGroup([{ ...inner, mixed: undefined }, c], measure([inner, c])!, 'Outer');
    expect(share(painted)).toEqual(share(mixed));
  });

  it('colors a copy of a group like the original, from the same build', () => {
    const g = twoTone();
    const original = colors(g);
    expect(Object.keys(original).sort()).toEqual(['#00ff00', '#ff0000']);
    const built = cacheSize();
    // A duplicate, a paste and the copies of an array all come from `cloneNode`: new ids, the same geometry.
    const copy = cloneNode(g);
    expect(copy.children.map((c) => c.id)).not.toEqual(g.children.map((c) => c.id));
    expect(colors(copy)).toEqual(original);
    expect(exportNodes([copy], false, false, true).faces?.sources).toEqual([[0], [1]]);
    // Repainted, the copy shows its own colors, face for face where the original showed its.
    const repainted: GroupNode = { ...copy, children: copy.children.map((c, i) => ({ ...c, color: i ? '#0000ff' : '#ffff00' })) };
    expect(colors(repainted)).toEqual({ '#ffff00': original['#ff0000'], '#0000ff': original['#00ff00'] });
    expect(cacheSize()).toBe(built);
  });

  it('counts places past the pictures on a group, which share its build', () => {
    const g = twoTone();
    const label: PictureNode = { ...base('Picture'), type: 'picture', asset: 'img', mapping: 'flat', angle: 120, natural: [1, 1, 1], size: [10, 10, 1] };
    const labelled: GroupNode = { ...g, children: [label, ...g.children] };
    expect(geomKey(labelled)).toBe(geomKey(g));
    expect(colors(labelled)).toEqual(colors(g));
  });

  it('tells two copies of one group inside a group apart', () => {
    const first = twoTone();
    const copy = cloneNode(first);
    const second: GroupNode = { ...copy, pos: add(first.pos, [0, 50, 0]), children: copy.children.map((c, i) => ({ ...c, color: i ? '#0000ff' : '#ffff00' })) };
    const outer = makeGroup([first, second], measure([first, second])!, 'Outer');
    const alone = colors(first);
    expect(colors(outer)).toEqual({ '#ff0000': alone['#ff0000'], '#00ff00': alone['#00ff00'], '#ffff00': alone['#ff0000'], '#0000ff': alone['#00ff00'] });
    // And a level further down: a copy of the pair inside another group beside the pair itself.
    const third = { ...cloneNode(first), pos: add(first.pos, [0, 100, 0]) };
    const wrapped = makeGroup([third], measure([third])!, 'Wrapped');
    const deep = makeGroup([first, wrapped], measure([first, wrapped])!, 'Deep');
    const got = share(deep);
    expect(Object.keys(got).sort()).toEqual([...first.children.map((c) => `${first.id}/${c.id}`), ...third.children.map((c) => `${wrapped.id}/${third.id}/${c.id}`)].sort());
    expect(make(deep).volume).toBeCloseTo(2 * make(first).volume, 3);
  });

  it('exports a group in place with the same face origins, and other things without', () => {
    const a = shape('box', { id: 'A', size: [10, 10, 10], pos: [-5, 0, 5] });
    const b = shape('box', { id: 'Bx', size: [10, 10, 10], pos: [5, 0, 5] });
    const g = makeGroup([a, b], measure([a, b])!, 'Two');
    const local = exportNodes([g], false, false, true);
    expect(local.faces?.sources).toEqual([[0], [1]]);
    expect(local.faces!.source.length).toBe(local.mesh.triangles.length / 3);
    expect(exportNodes([g], false, false, false).faces).toBeUndefined();
    expect(exportNodes([a], false, false, true).faces).toBeUndefined();
  });
});

describe('colored export', () => {
  /** Volume of an indexed mesh (closed, outward), by the divergence theorem. */
  const volumeOf = (m: MeshData): number => {
    let v = 0;
    const { positions: p, triangles: t } = m;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3];
      v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    return v;
  };

  it('writes a painted object as one part in its color, placed', () => {
    const box = shape('box', { size: [10, 20, 30], pos: [5, 0, 15], color: '#ff0000' });
    const { objects, warnings } = exportColored([box]);
    expect(warnings).toEqual([]);
    expect(objects).toHaveLength(1);
    expect(objects[0].parts.map((p) => p.color)).toEqual(['#ff0000']);
    expect(volumeOf(objects[0].parts[0].mesh)).toBeCloseTo(6000, 3);
    const xs = objects[0].parts[0].mesh.positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0, 5);
    expect(Math.max(...xs)).toBeCloseTo(10, 5);
  });

  it('splits a mixed group by color into parts that do not overlap, with the holes cut from each', () => {
    // A red box overlapped by a green box, with a bore through the overlap.
    const red = shape('box', { id: 'r', size: [20, 20, 20], pos: [0, 0, 10], color: '#ff0000' });
    const green = shape('box', { id: 'g', size: [20, 20, 20], pos: [10, 0, 10], color: '#00ff00' });
    const bore = shape('box', { id: 'h', size: [4, 4, 30], pos: [5, 0, 10], hole: true });
    const g = makeGroup([red, green, bore], measure([red, green, bore])!, 'Pair');
    const { objects } = exportColored([g]);
    expect(objects).toHaveLength(1);
    const parts = objects[0].parts;
    expect(parts.map((p) => p.color)).toEqual(['#ff0000', '#00ff00']);
    // Red keeps the overlap; green is what is left of its box; the bore is gone from both.
    expect(volumeOf(parts[0].mesh)).toBeCloseTo(20 * 20 * 20 - 4 * 4 * 20, 3);
    expect(volumeOf(parts[1].mesh)).toBeCloseTo(10 * 20 * 20, 3);
    expect(volumeOf(parts[0].mesh) + volumeOf(parts[1].mesh)).toBeCloseTo(make(g).volume, 3);
    // Painted, the same group is one part in its color.
    const painted = exportColored([{ ...g, mixed: undefined, color: '#0000ff' }]);
    expect(painted.objects[0].parts.map((p) => p.color)).toEqual(['#0000ff']);
    expect(volumeOf(painted.objects[0].parts[0].mesh)).toBeCloseTo(make(g).volume, 3);
  });

  it('carries the colors of a mixed group inside a mixed group, and merges parts of one color', () => {
    const a = shape('box', { id: 'a', size: [10, 10, 10], pos: [0, 0, 5], color: '#ff0000' });
    const b = shape('box', { id: 'b', size: [10, 10, 10], pos: [20, 0, 5], color: '#00ff00' });
    const inner = makeGroup([a, b], measure([a, b])!, 'Inner');
    const c = shape('box', { id: 'c', size: [10, 10, 10], pos: [40, 0, 5], color: '#ff0000' });
    const outer = makeGroup([inner, c], measure([inner, c])!, 'Outer');
    const { objects } = exportColored([outer]);
    const parts = objects[0].parts;
    expect(parts.map((p) => p.color)).toEqual(['#ff0000', '#00ff00']);
    expect(volumeOf(parts[0].mesh)).toBeCloseTo(2000, 3);
    expect(volumeOf(parts[1].mesh)).toBeCloseTo(1000, 3);
  });

  it('leaves out holes, hidden objects and pictures, and passes an open mesh through with a warning', () => {
    setAssets({ soup: meshAsset([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]) });
    const open = imported('soup', [10, 10, 1], { color: '#123456' });
    const hole = shape('box', { hole: true });
    const hidden = shape('box', { hidden: true });
    const { objects, warnings } = exportColored([open, hole, hidden]);
    expect(objects.map((o) => o.parts[0].color)).toEqual(['#123456']);
    expect(warnings).toHaveLength(1);
    expect(() => exportColored([hole])).toThrow(/nothing to export/);
  });
});

describe('faces that are meant to meet', () => {
  /** Coordinates of result vertices that lie within a hair of `value` on `axis` without being exactly there. */
  const nearMisses = (node: SceneNode, axis: number, value: number): number[] => {
    // The drawn mesh is single precision; a vertex exactly on the face rounds the same way as the face.
    const p = build(geomKey(node), node).render.positions;
    const out = new Set<number>();
    for (let i = axis; i < p.length; i += 3) {
      const d = Math.abs(p[i] - Math.fround(value));
      if (d > 1e-9 && d < 1e-2) out.add(p[i]);
    }
    return [...out];
  };

  it('cuts a hole flush with a face whose position is not a round number', () => {
    // A box turned 30 degrees has faces at irrational coordinates; grouping it keeps them exact.
    const turned = shape('box', { size: [20, 20, 10], rot: [0, 0, 30] });
    const bounds = measure([turned])!;
    const inner = makeGroup([turned], bounds, 'Turned');
    const r = build(geomKey(inner), inner);
    const face = inner.pos[0] + r.bounds.max[0];
    expect(face).toBeCloseTo(10 * Math.cos(Math.PI / 6) + 10 * Math.sin(Math.PI / 6), 12);

    // A cutter lined up with that face by the same arithmetic the editor uses.
    const cutter = shape('box', { size: [4, 40, 4], hole: true });
    const boundsOf = (node: SceneNode): Bounds => {
      const b = build(geomKey(node), node).bounds;
      return { min: add(node.pos, b.min), max: add(node.pos, b.max) };
    };
    const [placed] = alignNodes([cutter], boundsOf, 0, 'max', boundsOf(inner));
    const outer = makeGroup([inner, placed], measure([inner, placed])!, 'Cut');
    // No paper-thin wall left standing next to the face.
    expect(nearMisses(outer, 0, face - outer.pos[0])).toEqual([]);
  });

  it('keeps a quarter-turned cutter flush with the face it is on', () => {
    const block = shape('box', { size: [30, 20, 10] });
    // Turned about Z and lined up with the top and the +Y face: all three must stay exact.
    const cutter = shape('fillet', { size: [5, 30, 5], rot: [0, 0, 90], hole: true });
    const boundsOf = (node: SceneNode): Bounds => {
      const b = build(geomKey(node), node).bounds;
      const m = nodeMatrix(node);
      const out = emptyBounds();
      for (let i = 0; i < 8; i++) expandBounds(out, apply(m, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]));
      return out;
    };
    let [placed] = alignNodes([cutter], boundsOf, 1, 'max', boundsOf(block));
    [placed] = alignNodes([placed], boundsOf, 2, 'max', boundsOf(block));
    const group = makeGroup([block, placed], measure([block, placed])!, 'Rounded');
    expect(nearMisses(group, 1, 10 - group.pos[1])).toEqual([]);
    expect(nearMisses(group, 2, 10 - group.pos[2])).toEqual([]);
    expect(build(geomKey(group), group).volume).toBeCloseTo(6000 - 30 * 25 * (1 - 8 * Math.sin(Math.PI / 32)), 3);
  });
});

describe('lettering', () => {
  const text = (over: Partial<TextNode> = {}): TextNode => ({
    ...base('Label'),
    type: 'text',
    text: 'O',
    font: 'sans',
    align: 'left',
    natural: [10, 10, 1],
    size: [10, 10, 1],
    hole: false,
    color: '#e6e1d6',
    ...over,
  });
  const square = (h: number): Polygon => [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  // Counter wound the other way, as in a font.
  const ring = (): Polygon[] => [square(5), [...square(2)].reverse()];

  it('extrudes the outlines sent along under its text key', () => {
    const node = text();
    setAssets({ [textAssetKey(node)]: { kind: 'outline', shapes: [{ contours: ring(), evenodd: false }] } });
    const r = build(geomKey(node), node);
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(100 - 16, 6);
    expect(r.bounds.min[2]).toBeCloseTo(-0.5);
    expect(r.bounds.max[2]).toBeCloseTo(0.5);
  });

  it('engraves when it is a hole in a group', () => {
    const label = text({ size: [10, 10, 2], pos: [0, 0, 9.5], hole: true });
    setAssets({ [textAssetKey(label)]: { kind: 'outline', shapes: [{ contours: ring(), evenodd: false }] } });
    const block = { ...base('Block'), type: 'shape', shape: 'box', params: defaultParams('box'), size: [20, 20, 20], hole: false, color: '#8fa3bf' } as ShapeNode;
    const group: GroupNode = { ...base('Group'), type: 'group', natural: [20, 20, 20], size: [20, 20, 20], hole: false, color: '#8fa3bf', children: [block, label] };
    // The lettering reaches a millimeter and a half into the top of the block.
    expect(build(geomKey(group), group).volume).toBeCloseTo(8000 - 84 * 1.5, 4);
  });

  it('says so when the outlines are missing', () => {
    const node = text({ text: 'never sent' });
    expect(() => build(geomKey(node), node)).toThrow(/no letters/);
  });

  it('bends lettering round a cylinder and lays it along an arc, keeping its volume and filling the box the editor expects', () => {
    for (const curve of [
      { kind: 'bend', angle: 180, flip: false, thickness: 1 },
      { kind: 'bend', angle: 120, flip: true, thickness: 2 },
      { kind: 'arc', angle: 90, flip: false, thickness: 1 },
    ] as const) {
      const natural = curvedSize(curve, [10, 10], curve.thickness);
      const node = text({ curve, natural, size: natural });
      setAssets({ [textAssetKey(node)]: { kind: 'outline', shapes: [{ contours: ring(), evenodd: false }] } });
      const r = build(geomKey(node), node);
      expect(r.watertight, curve.kind).toBe(true);
      // The back face (or the baseline) keeps the flat length on its circle, so the letters' middle runs a longer
      // (or, inside, a shorter) way round: the volume grows by the middle radius over the back's.
      const radius = 10 / ((curve.angle * Math.PI) / 180);
      const middle = curve.kind === 'bend' ? radius + (curve.flip ? -1 : 1) * (curve.thickness / 2) : radius + 5;
      expect(r.volume).toBeCloseTo((84 * curve.thickness * middle) / radius, 0);
      for (let k = 0; k < 3; k++) {
        expect(r.bounds.max[k] - r.bounds.min[k], `${curve.kind} ${k}`).toBeCloseTo(natural[k], 1);
        expect(r.bounds.max[k] + r.bounds.min[k], `${curve.kind} centre ${k}`).toBeCloseTo(0, 6);
      }
      // A different curve is different geometry.
      expect(geomKey(node)).not.toBe(geomKey(text({ curve: { ...curve, angle: curve.angle + 10 }, natural, size: natural })));
    }
  });

  it('cuts curved lettering no finer than its triangle budget allows', () => {
    // A tall, narrow column of lettering wrapped nearly all the way round: cut at the step its curve
    // asks for, it would come to well over a million triangles.
    const curve = { kind: 'bend', angle: 355, flip: false, thickness: 1 } as const;
    const natural = curvedSize(curve, [4, 150], 1);
    const node = text({ text: 'column', curve, natural, size: natural });
    const column: Polygon = [
      [-2, -75],
      [2, -75],
      [2, 75],
      [-2, 75],
    ];
    setAssets({ [textAssetKey(node)]: { kind: 'outline', shapes: [{ contours: [column], evenodd: false }] } });
    const r = build(geomKey(node), node);
    expect(r.watertight).toBe(true);
    expect(r.triangles).toBeLessThan(1.5 * CURVED_TRIANGLES);
    expect(r.triangles).toBeGreaterThan(0.5 * CURVED_TRIANGLES);
    // Still the same lettering, round the same cylinder.
    const radius = 4 / ((355 * Math.PI) / 180);
    expect(r.volume / ((600 * (radius + 0.5)) / radius)).toBeCloseTo(1, 2);
    for (let k = 0; k < 3; k++) expect(r.bounds.max[k] - r.bounds.min[k]).toBeCloseTo(natural[k], 1);
  });
});

describe('imported outlines', () => {
  const square = (h: number, cx = 0): Polygon => [
    [cx - h, -h],
    [cx + h, -h],
    [cx + h, h],
    [cx - h, h],
  ];

  beforeEach(() => {
    setAssets({
      frame: { kind: 'outline', shapes: [{ contours: [square(5), square(2)], evenodd: true }] },
      // The same contours wound the same way fill the inner one under the non-zero rule.
      solid: { kind: 'outline', shapes: [{ contours: [square(5), square(2)], evenodd: false }] },
      pair: {
        kind: 'outline',
        shapes: [
          { contours: [square(5, -5)], evenodd: true },
          { contours: [square(5, 3)], evenodd: false },
        ],
      },
      nothing: { kind: 'outline', shapes: [] },
      // Stray points and lines, as sloppy artwork has them, around one real square.
      messy: {
        kind: 'outline',
        shapes: [
          { contours: [], evenodd: true },
          { contours: [[[0, 0], [1, 1]], square(5), [[2, 2]]], evenodd: false },
          { contours: [[[0, 0], [3, 0]]], evenodd: true },
        ],
      },
    });
  });

  it('extrudes them 1 mm, centered', () => {
    const r = make(imported('frame', [10, 10, 1], { size: [10, 10, 5] }));
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(100 - 16, 6);
    expectBounds(r.bounds, [-5, -5, -0.5], [5, 5, 0.5]);
  });

  it('honors the fill rule and merges shapes', () => {
    expect(make(imported('solid', [10, 10, 1])).volume).toBeCloseTo(100, 6);
    const pair = make(imported('pair', [18, 10, 1]));
    expect(pair.volume).toBeCloseTo(180, 6);
    expectBounds(pair.bounds, [-10, -5, -0.5], [8, 5, 0.5]);
  });

  it('ignores contours that enclose nothing', () => {
    expect(make(imported('messy', [10, 10, 1])).volume).toBeCloseTo(100, 6);
  });

  it('scales with the node inside a group', () => {
    const r = make(group([10, 10, 5], [imported('frame', [10, 10, 1], { size: [10, 10, 5] })]));
    expect(r.volume).toBeCloseTo(84 * 5, 6);
    expectBounds(r.bounds, [-5, -5, -2.5], [5, 5, 2.5]);
  });

  it('explains missing and empty artwork', () => {
    expect(() => make(imported('nothing', [1, 1, 1]))).toThrow(/no filled areas/);
    expect(() => make(imported('no-such-asset', [1, 1, 1]))).toThrow(/missing/);
  });
});

describe('imported meshes', () => {
  // Every triangle with corners of its own, like an STL file.
  const soup = CUBE_TRIANGLES.flatMap((v) => CUBE_POSITIONS.slice(v * 3, v * 3 + 3));
  const inverted = CUBE_TRIANGLES.flatMap((_, i) => CUBE_TRIANGLES[i - (i % 3) + [0, 2, 1][i % 3]]);
  const open = CUBE_TRIANGLES.slice(3);

  beforeEach(() => {
    setAssets({
      cube: meshAsset(CUBE_POSITIONS, CUBE_TRIANGLES),
      soup: meshAsset(soup, soup.map((_, i) => i).slice(0, soup.length / 3)),
      inverted: meshAsset(CUBE_POSITIONS, inverted),
      open: meshAsset(CUBE_POSITIONS, open),
    });
  });

  it('decodes base64 with or without padding', () => {
    expect([...decodeBase64('AQID')]).toEqual([1, 2, 3]);
    expect([...decodeBase64('AQIDBA==')]).toEqual([1, 2, 3, 4]);
    expect([...decodeBase64('AQIDBA')]).toEqual([1, 2, 3, 4]);
    expect(decodeBase64('')).toHaveLength(0);
  });

  it('builds a watertight mesh as a solid', () => {
    const r = make(imported('cube', [2, 2, 2]));
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(8, 6);
    expect(r.triangles).toBe(12);
    expectBounds(r.bounds, [-1, -1, -1], [1, 1, 1]);
  });

  it('joins coinciding vertices and turns inside-out meshes around', () => {
    const r = make(imported('soup', [2, 2, 2]));
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(8, 6);
    expect(make(imported('inverted', [2, 2, 2])).volume).toBeCloseTo(8, 6);
    // Usable in a group like any other solid.
    const cut = shape('box', { size: [20, 20, 20], pos: [0, 0, 10], hole: true });
    const half = make(group([20, 20, 10], [imported('inverted', [2, 2, 2], { size: [20, 20, 20] }), cut]));
    expect(half.volume).toBeCloseTo(4000, 3);
  });

  it('forgets the imported data of a closed design, keeping what is still wanted', () => {
    // Leftovers of earlier tests go first, so that the second call below drops nothing.
    const these = ['cube', 'soup', 'inverted', 'open'];
    forgetAssets(these);
    make(imported('cube', [2, 2, 2]));
    expect(cacheSize()).toBeGreaterThan(0);
    forgetAssets(these);
    // Nothing was dropped, so nothing built needs rebuilding.
    expect(cacheSize()).toBeGreaterThan(0);
    forgetAssets(['soup']);
    expect(cacheSize()).toBe(0);
    expect(make(imported('soup', [2, 2, 2])).volume).toBeCloseTo(8, 6);
    expect(() => make(imported('cube', [2, 2, 2]))).toThrow(/missing from this design/);
  });

  it('shows a mesh that is not watertight without treating it as a solid', () => {
    const r = make(imported('open', [2, 2, 2]));
    expect(r.watertight).toBe(false);
    expect(r.volume).toBe(0);
    expect(r.triangles).toBe(11);
    expect(r.render.positions.length).toBe(11 * 9);
    expect(r.render.normals.length).toBe(11 * 9);
    expectBounds(r.bounds, [-1, -1, -1], [1, 1, 1]);
  });

  it('refuses to combine a mesh that is not watertight', () => {
    const node = imported('open', [2, 2, 2], { name: 'Scan' });
    const message = '"Scan" is not a watertight mesh, so it cannot be combined with other shapes.';
    expect(() => make(group([20, 20, 20], [shape('box'), node]))).toThrow(message);
    expect(() => measure([shape('box'), node])).toThrow(message);
    expect(() => measure([node])).toThrow(message);
  });

  it('exports a mesh that is not watertight as it is, with a warning', () => {
    const node = imported('open', [2, 2, 2], { name: 'Scan', size: [4, 2, 2], pos: [50, 0, 0] });
    const alone = exportNodes([node], false);
    expect(alone.warnings).toEqual(['"Scan" is not watertight and was exported as-is.']);
    expect(alone.mesh.triangles.length).toBe(11 * 3);
    expect(alone.volume).toBe(0);
    expect(alone.outline).toBeUndefined();
    expectBounds(alone.bounds, [48, -1, -1], [52, 1, 1]);

    const box = shape('box');
    const both = exportNodes([box, node], true);
    expect(both.warnings).toHaveLength(1);
    expect(both.warnings[0]).toMatch(/"Scan" is not watertight/);
    expect(both.mesh.triangles.length).toBe((12 + 11) * 3);
    expect(both.mesh.positions.length).toBe((8 + 8) * 3);
    expect(Math.max(...both.mesh.triangles)).toBe(15);
    expect(both.volume).toBeCloseTo(8000, 6);
    expectBounds(both.bounds, [-10, -10, -10], [52, 10, 10]);
    expect(area(both.outline!)).toBeCloseTo(400, 6);
  });

  it('keeps a mirrored open mesh facing outwards', () => {
    const node = imported('open', [2, 2, 2]);
    const plain = signedVolume(exportNodes([node], false).mesh);
    const mirrored = signedVolume(exportNodes([{ ...node, flip: [false, true, false], rot: [30, 0, 0] }], false).mesh);
    expect(plain).toBeGreaterThan(0);
    expect(mirrored).toBeCloseTo(plain, 4);
  });

  it('refuses a mesh whose points have no position', () => {
    const broken = CUBE_POSITIONS.slice();
    broken[4] = NaN;
    setAssets({ broken: meshAsset(broken, CUBE_TRIANGLES), far: meshAsset([...CUBE_POSITIONS.slice(0, 23), Infinity], CUBE_TRIANGLES) });
    expect(() => make(imported('broken', [2, 2, 2], { name: 'Scan' }))).toThrow('The mesh of "Scan" is damaged: some points have no position.');
    expect(() => make(imported('far', [2, 2, 2], { name: 'Scan' }))).toThrow(/damaged/);
  });

  it('exports an open mesh in place as a copy, so handing the copy away leaves the cache whole', () => {
    const node = imported('open', [2, 2, 2], { name: 'Scan', size: [4, 2, 2], pos: [50, 0, 0] });
    const first = exportNodes([node], false, false, true);
    expect(first.mesh.triangles.length).toBe(11 * 3);
    expectBounds(first.bounds, [-1, -1, -1], [1, 1, 1]);
    // What the worker does with the result: its arrays go to the main thread, which empties them here.
    structuredClone(first.mesh, { transfer: [first.mesh.positions.buffer, first.mesh.triangles.buffer] });
    expect(first.mesh.positions.length).toBe(0);
    const second = exportNodes([node], false, false, true);
    expect(second.mesh.positions.length).toBe(8 * 3);
    expect(second.mesh.triangles.length).toBe(11 * 3);
    expect(second.mesh.positions === first.mesh.positions).toBe(false);
    expect(second.mesh.triangles === first.mesh.triangles).toBe(false);
    expect(signedVolume(second.mesh)).toBeGreaterThan(0);
    // Placed exports and builds of the same mesh are untouched too.
    const placed = exportNodes([node], false);
    expect(placed.mesh.triangles.length).toBe(11 * 3);
    expectBounds(placed.bounds, [48, -1, -1], [52, 1, 1]);
    const r = make(node);
    expect(r.triangles).toBe(11);
    expect(r.render.positions.length).toBe(11 * 9);
  });

  it('rebuilds when an asset is replaced under the same name', () => {
    const node = imported('cube', [2, 2, 2]);
    expect(make(node).volume).toBeCloseTo(8, 6);
    setAssets({ cube: meshAsset(CUBE_POSITIONS.map((v) => v * 2), CUBE_TRIANGLES) });
    expect(make(node).volume).toBeCloseTo(64, 6);
  });

  it('rebuilds when only the texture coordinates of an asset are replaced', () => {
    const node = imported('mapped', [2, 2, 2]);
    const withUv = (u: number): Asset => ({ ...meshAsset(CUBE_POSITIONS, CUBE_TRIANGLES), uv: encode(new Float32Array(CUBE_TRIANGLES.length * 2).fill(u)) } as Asset);
    setAssets({ mapped: withUv(0.25) });
    expect(Array.from(new Set(make(node).render.uv))).toEqual([0.25]);
    setAssets({ mapped: withUv(0.75) });
    expect(Array.from(new Set(make(node).render.uv))).toEqual([0.75]);
  });
});

describe('exportNodes', () => {
  it('merges the solids into one indexed mesh', () => {
    const r = exportNodes([shape('box', { pos: [-5, 0, 10] }), shape('box', { pos: [5, 0, 10] })], false);
    expect(r.volume).toBeCloseTo(30 * 20 * 20, 6);
    expect(r.warnings).toEqual([]);
    expect(r.outline).toBeUndefined();
    expectBounds(r.bounds, [-15, -10, 0], [15, 10, 20]);
    expect(r.mesh.positions.length % 3).toBe(0);
    expect(r.mesh.triangles.length % 3).toBe(0);
    expect(Math.max(...r.mesh.triangles)).toBe(r.mesh.positions.length / 3 - 1);
    expect(signedVolume(r.mesh) / 6).toBeCloseTo(r.volume, 2);
  });

  it('leaves out holes and hidden nodes', () => {
    const box = shape('box');
    const hole = shape('cylinder', { size: [10, 10, 30], hole: true });
    const hidden = shape('box', { pos: [100, 0, 0], hidden: true });
    const r = exportNodes([box, hole, hidden], false);
    // Holes only cut inside groups.
    expect(r.volume).toBeCloseTo(8000, 6);
    expectBounds(r.bounds, [-10, -10, -10], [10, 10, 10]);
    expect(exportNodes([drilled(), hidden], false).volume).toBeCloseTo(DRILLED_VOLUME, 3);
  });

  it('says so when there is nothing to export', () => {
    expect(() => exportNodes([], false)).toThrow('There is nothing to export.');
    const hole = shape('box', { hole: true });
    expect(() => exportNodes([hole, shape('box', { hidden: true })], true)).toThrow('There is nothing to export.');
  });

  it('returns the outline seen from above when asked', () => {
    const r = exportNodes([drilled(), shape('box', { size: [10, 10, 10], pos: [30, 0, 0], rot: [0, 0, 45] })], true);
    expect(r.outline).toBeDefined();
    // Two islands and the bore.
    expect(r.outline).toHaveLength(3);
    expect(area(r.outline!)).toBeCloseTo(400 - around(64, 5) + 100, 3);
    for (const contour of r.outline!) for (const p of contour) expect(p).toHaveLength(2);
  });

  it('places mirrored and scaled nodes', () => {
    const wedge = shape('wedge', { size: [40, 10, 20], flip: [true, false, false], pos: [0, 0, 10] });
    const cut = shape('box', { size: [20, 10, 20], pos: [-10, 0, 10], hole: true });
    const kept = exportNodes([group([20, 10, 20], [wedge, cut], { pos: [10, 0, 10] })], false);
    // Mirrored, the tall end is at +X: three quarters of the wedge survive the cut.
    expect(kept.volume).toBeCloseTo(0.75 * 0.5 * 40 * 10 * 20, 4);
    expect(signedVolume(kept.mesh) / 6).toBeCloseTo(kept.volume, 1);
  });
});

describe('cache', () => {
  it('stays bounded and rebuilds what it dropped', () => {
    const cone = (i: number) => shape('cone', { params: { sides: 3, top: i / 1000 } });
    const first = make(cone(0)).volume;
    for (let i = 1; i < 450; i++) make(cone(i));
    expect(cacheSize()).toBeLessThanOrEqual(400);
    expect(make(cone(0)).volume).toBe(first);
  });

  it('keeps every part of a large group alive while it is being built', () => {
    clearCache();
    const parts = Array.from({ length: 450 }, (_, i) => {
      const pos: Vec3 = [(i % 30) * 3, Math.floor(i / 30) * 3, 0];
      return shape('cone', { size: [2, 2, 2], pos, params: { sides: 4, top: i / 1000 } });
    });
    let expected = 0;
    for (const p of parts) {
      const t = p.params.top;
      // Frustum on a 2 by 2 base, 2 high.
      expected += (2 / 3) * 4 * (1 + t + t * t);
    }
    const g = group([89, 44, 2], parts);
    const r = make(g);
    expect(r.volume).toBeCloseTo(expected, 3);
    // Asking again is answered from the cache, and later requests trim it back.
    expect(make(g).volume).toBe(r.volume);
    make(shape('box'));
    expect(cacheSize()).toBeLessThanOrEqual(400);
  });

  it('exports at fine detail with twice the facets, without touching what is shown', () => {
    const cyl = shape('cylinder', { size: [20, 20, 10] });
    const sides = cyl.params.sides;
    const shown = exportNodes([cyl], false);
    const fine = exportNodes([cyl], false, true);
    expect(fine.mesh.triangles.length).toBeGreaterThan(shown.mesh.triangles.length * 1.5);
    // Closer to a true circle: 2 * sides facets around.
    expect(shown.volume).toBeCloseTo(around(sides, 10) * 10, 3);
    expect(fine.volume).toBeCloseTo(around(2 * sides, 10) * 10, 3);
    // The viewport's build is unchanged, and the fine solid lives under a key of its own.
    const before = cacheSize();
    expect(make(cyl).volume).toBeCloseTo(around(sides, 0.5), 6);
    expect(cacheSize()).toBe(before);
    // A faceted cylinder and a prism keep their sides: those are the shape.
    const hex = shape('cylinder', { size: [20, 20, 10], params: { sides: 6, radius: 0 } });
    expect(exportNodes([hex], false, true).volume).toBeCloseTo(exportNodes([hex], false).volume, 6);
    const prism = shape('prism', { size: [20, 20, 10] });
    expect(exportNodes([prism], false, true).volume).toBeCloseTo(exportNodes([prism], false).volume, 6);
    // Inside a group too.
    const g = group([20, 20, 10], [{ ...cyl, pos: [0, 0, 0] }]);
    expect(exportNodes([g], false, true).volume).toBeCloseTo(fine.volume, 3);
    expect(exportNodes([g], false).volume).toBeCloseTo(shown.volume, 3);
  });
});

describe('the outline of round things', () => {
  it('is read back as a circle for a cylinder, and as arcs for the corners of a rounded box', () => {
    const cyl = shape('cylinder', { size: [20, 20, 10], pos: [30, -5, 5] });
    const [round] = exportNodes([cyl], true, true).outline!;
    const circle = traceArcs(round);
    if (!('circle' in circle)) throw new Error('the outline of a cylinder is a circle');
    expect(circle.circle.radius).toBeCloseTo(10, 4);
    expect(circle.circle.center[0]).toBeCloseTo(30, 4);
    expect(circle.circle.center[1]).toBeCloseTo(-5, 4);

    const box = shape('box', { size: [40, 30, 10], params: { ...defaultParams('box'), radius: 5 } });
    const [rounded] = exportNodes([box], true, true).outline!;
    const traced = traceArcs(rounded);
    if ('circle' in traced) throw new Error('a rounded box is no circle');
    const arcs = traced.sides.filter((s) => s.arc);
    expect(arcs).toHaveLength(4);
    for (const s of arcs) {
      expect(s.arc!.radius).toBeCloseTo(5, 4);
      expect(Math.abs(s.arc!.sweep)).toBeCloseTo(Math.PI / 2, 6);
    }
    expect(traced.sides.filter((s) => !s.arc)).toHaveLength(4);
  });

  it('is a circle for a hole drilled through a plate, too', () => {
    const plate = shape('box', { size: [40, 30, 4], pos: [0, 0, 2] });
    const hole = shape('cylinder', { size: [8, 8, 10], pos: [5, 3, 2], hole: true });
    const outline = exportNodes([group([40, 30, 4], [plate, hole])], true, true).outline!;
    const traced = outline.map(traceArcs);
    const circles = traced.filter((t) => 'circle' in t);
    expect(circles).toHaveLength(1);
    expect('circle' in circles[0] && circles[0].circle.radius).toBeCloseTo(4, 4);
  });
});

describe('what a build brings for the viewer', () => {
  it('brings a tree that a ray finds the right face of the mesh through', () => {
    const box = shape('box', { size: [20, 20, 20] });
    const r = build(geomKey(box), box);
    // Built at unit size, centered: straight down onto the top, at a point off the diagonal.
    const hit = castRay(r.bvh, r.render.positions, [0.3, 0.1, 5], [0, 0, -1])!;
    expect(hit.t).toBeCloseTo(4.5, 6);
    const p = r.render.positions.subarray(hit.triangle * 9, hit.triangle * 9 + 9);
    expect([p[2], p[5], p[8]]).toEqual([0.5, 0.5, 0.5]);
    expect([...r.bvh.order].sort((a, b) => a - b)).toEqual(Array.from({ length: r.triangles }, (_, i) => i));
  });

  it('brings the edge lines: the twelve of a box, the two rims of a round cylinder', () => {
    const box = shape('box', { size: [20, 20, 20] });
    expect(build(geomKey(box), box).edges!.length / 6).toBe(12);
    const cyl = shape('cylinder', { size: [20, 20, 10] });
    expect(build(geomKey(cyl), cyl).edges!.length / 6).toBe(2 * cyl.params.sides);
  });

  it('brings both for an open mesh too, whose rim is an edge', () => {
    // A square of two triangles.
    const positions = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
    const triangles = Uint32Array.from([0, 1, 2, 0, 2, 3]);
    const bytes = (a: Float32Array | Uint32Array) => btoa(String.fromCharCode(...new Uint8Array(a.buffer)));
    setAssets({ sheet: { kind: 'mesh', positions: bytes(positions), triangles: bytes(triangles) } });
    const node: ImportNode = { ...base('Sheet'), type: 'import', asset: 'sheet', natural: [10, 10, 1], size: [10, 10, 1] };
    const r = build(geomKey(node), node);
    expect(r.watertight).toBe(false);
    expect(r.edges!.length / 6).toBe(4);
    expect(castRay(r.bvh, r.render.positions, [2, 1, 5], [0, 0, -1])?.t).toBeCloseTo(5, 6);
    forgetAssets([]);
  });
});

describe('parts', () => {
  it('builds a part once for its box and its mesh', () => {
    clearCache();
    const def = getGenerator('rack');
    const made = vi.spyOn(def, 'build');
    try {
      const node: SceneNode = { ...base('Rack'), type: 'part', part: 'rack', params: {}, natural: [1, 1, 1], size: [1, 1, 1] };
      const box = partBox(node)!;
      expect(box.max[0] - box.min[0]).toBeGreaterThan(1);
      const r = build(geomKey(node), node);
      expect(made).toHaveBeenCalledTimes(1);
      // The mesh is the part centered on its box.
      for (let i = 0; i < 3; i++) {
        expect(r.bounds.max[i] - r.bounds.min[i]).toBeCloseTo(box.max[i] - box.min[i], 6);
        expect(r.bounds.max[i] + r.bounds.min[i]).toBeCloseTo(0, 6);
      }
    } finally {
      made.mockRestore();
    }
  });
});

describe('the mended binding', () => {
  /** A gear-like outline: `teeth` bumps around a circle of radius 10. */
  const gear = (teeth: number): [number, number][] =>
    Array.from({ length: teeth * 8 }, (_, i) => {
      const a = (i * 2 * Math.PI) / (teeth * 8);
      const r = 10 + (i % 8 < 4 ? 1 : -1);
      return [r * Math.cos(a), r * Math.sin(a)];
    });

  // The binding as shipped: the polygons handed to the kernel are never freed.
  type Leaky = {
    _Extrude(p: unknown, h: number, d: number, t: number, s: { x: number; y: number }): import('manifold-3d').Manifold;
    _Revolve(p: unknown, s: number, d: number): import('manifold-3d').Manifold;
  };
  const polygonsOf = (cs: unknown) => (cs as { _ToPolygons(): unknown })._ToPolygons();

  it('extrudes and revolves exactly as the binding did', () => {
    const cs = new k.CrossSection(gear(12), 'EvenOdd');
    const section = new k.CrossSection([gear(12).map(([x, y]) => [x + 15, y])], 'EvenOdd');
    const leaky = k as unknown as Leaky;
    const pairs = [
      [cs.extrude(5, 0, 0, [1, 1]), leaky._Extrude(polygonsOf(cs), 5, 0, 0, { x: 1, y: 1 })],
      [cs.extrude(5, 10, 30, [0.5, 0.5]), leaky._Extrude(polygonsOf(cs), 5, 10, 30, { x: 0.5, y: 0.5 })],
      [section.revolve(48), leaky._Revolve(polygonsOf(section), 48, 360)],
      [section.revolve(48, 90), leaky._Revolve(polygonsOf(section), 48, 90)],
    ];
    for (const [ours, theirs] of pairs) {
      expect(ours.status()).toBe('NoError');
      expect(ours.numTri()).toBe(theirs.numTri());
      expect(ours.volume()).toBeCloseTo(theirs.volume(), 9);
      expect(ours.boundingBox()).toEqual(theirs.boundingBox());
      ours.delete();
      theirs.delete();
    }
    // Known values as well: the gear outline has the area of a ring of radius 10 and width 2 cut in two.
    const plain = cs.extrude(5);
    expect(plain.volume()).toBeCloseTo(cs.area() * 5, 6);
    expect(cs.area()).toBeGreaterThan(Math.PI * 81);
    expect(cs.area()).toBeLessThan(Math.PI * 121);
    plain.delete();
    // The defaults, a scalar top scale and centering work too.
    const scaled = cs.extrude(4, 0, 0, 0.5, true);
    const box = scaled.boundingBox();
    expect(box.min[2]).toBeCloseTo(-2, 6);
    expect(box.max[2]).toBeCloseTo(2, 6);
    expect(box.max[0]).toBeCloseTo(11, 6);
    expect(scaled.volume()).toBeCloseTo((cs.area() * 4 * (1 + 0.5 + 0.25)) / 3, 6);
    scaled.delete();
    cs.delete();
    section.delete();
  });

  it('makes a solid from a bad mesh without throwing, so that it can be freed', () => {
    const mesh = new k.Mesh({ numProp: 3, vertProperties: Float32Array.from(CUBE_POSITIONS), triVerts: Uint32Array.from(CUBE_TRIANGLES.slice(3)) });
    expect(() => new k.Manifold(mesh)).toThrow();
    const solid = new (rawManifold(k))(mesh);
    expect(solid.status()).not.toBe('NoError');
    solid.delete();
    const good = new (rawManifold(k))(new k.Mesh({ numProp: 3, vertProperties: Float32Array.from(CUBE_POSITIONS), triVerts: Uint32Array.from(CUBE_TRIANGLES) }));
    expect(good.status()).toBe('NoError');
    expect(good.volume()).toBeCloseTo(8, 6);
    expect(good).toBeInstanceOf(k.Manifold);
    good.delete();
  });
});

describe('robot links', () => {
  it('weighs a placed box: volume, centroid and inertia follow the node', async () => {
    const { massProperties } = await import('./kernel');
    const box = shape('box', { size: [20, 30, 40], pos: [5, 6, 20] });
    const [p] = massProperties([box]);
    expect(p.id).toBe(box.id);
    expect(p.watertight).toBe(true);
    expect(p.volume).toBeCloseTo(24000, 1);
    expect(p.area).toBeCloseTo(2 * (600 + 1200 + 800), 1);
    expect(p.centroid.map((v) => +v.toFixed(4))).toEqual([5, 6, 20]);
    expect(p.unit[0]).toBeCloseTo((900 + 1600) / 12, 3);
  });

  it('weighs an open mesh as the solid stretched tight round it, the same wherever it stands', async () => {
    const { massProperties } = await import('./kernel');
    // A box of 4 by 2 by 2 with one triangle of its skin missing: what its triangles enclose is no volume at all.
    setAssets({ open: meshAsset(CUBE_POSITIONS, CUBE_TRIANGLES.slice(3)) });
    const near = imported('open', [2, 2, 2], { name: 'Shell', size: [4, 2, 2], pos: [0, 0, 1] });
    const far = imported('open', [2, 2, 2], { name: 'Shell', size: [4, 2, 2], pos: [193, 46, 400] });
    const [a, b] = massProperties([near, far]);
    for (const p of [a, b]) {
      expect(p.watertight).toBe(false);
      expect(p.triangles).toBe(11);
      expect(p.volume).toBeCloseTo(16, 3);
      // A box's own inertia for each unit of its mass, which no stand of the mesh changes.
      expect(p.unit.slice(0, 3).map((v) => +v.toFixed(3))).toEqual([+((4 + 4) / 12).toFixed(3), +((16 + 4) / 12).toFixed(3), +((16 + 4) / 12).toFixed(3)]);
      // The two smaller moments together are no less than the largest: a body a simulator takes.
      const [x, y, z] = [...p.unit.slice(0, 3)].sort((m, n) => m - n);
      expect(x + y).toBeGreaterThanOrEqual(z - 1e-9);
    }
    expect(a.centroid.map((v) => +v.toFixed(3))).toEqual([0, 0, 1]);
    expect(b.centroid.map((v) => +v.toFixed(3))).toEqual([193, 46, 400]);
  });

  it('gives each link its visual parts, the collision shape asked for and its bounds', async () => {
    const { robotGeometry } = await import('./kernel');
    const body = shape('box', { size: [20, 20, 10], pos: [0, 0, 5] });
    const wheel = shape('cylinder', { size: [10, 10, 4], pos: [15, 0, 5], rot: [90, 0, 0] });
    const [b, w] = robotGeometry([body, wheel], { [body.id]: 'box', [wheel.id]: 'hull' }, false);
    expect(b.collision).toBeNull();
    expect(b.bounds.min.map((v) => +v.toFixed(4))).toEqual([-10, -10, 0]);
    expect(b.visual).toHaveLength(1);
    expect(b.visual[0].color).toBe(body.color);
    // A convex cylinder's hull is the cylinder, give or take a facet.
    expect(w.collision).not.toBeNull();
    expect(w.collision!.triangles.length / 3).toBeGreaterThan(20);
    expect(w.props.volume).toBeCloseTo(Math.PI * 25 * 4, -1);
    // Placed: the wheel's centroid is where the node is.
    expect(w.props.centroid.map((v) => +v.toFixed(3))).toEqual([15, 0, 5]);
    const [m] = robotGeometry([body], { [body.id]: 'mesh' }, false);
    expect(m.collision!.triangles.length).toBe(36);
  });

  it('wraps each part of a group in a hull of its own, and leaves out a part inside another', async () => {
    const { collisionMeshes, robotGeometry } = await import('./kernel');
    // Two posts on a bar, a U: one hull round it would fill the gap between the posts.
    const bar = shape('box', { size: [40, 10, 10], pos: [0, 0, -10] });
    const left = shape('box', { size: [10, 10, 20], pos: [-15, 0, 5] });
    const right = shape('box', { size: [10, 10, 20], pos: [15, 0, 5] });
    const pin = shape('box', { size: [4, 4, 4], pos: [0, 0, -10] });
    const u = group([40, 10, 30], [bar, left, right, pin], { pos: [100, 0, 15] });
    const [g] = robotGeometry([u], {}, false);
    expect(g.hulls).toHaveLength(3);
    const volumes = g.hulls!.map((m) => meshProperties(m).volume).sort((a, b) => a - b);
    expect(volumes.map((v) => Math.round(v))).toEqual([2000, 2000, 4000]);
    // Nothing of them between the posts, above the bar.
    for (const m of g.hulls!) for (let i = 0; i < m.positions.length; i += 3) expect(Math.abs(m.positions[i] - 100) < 9 && m.positions[i + 2] > 10.01).toBe(false);
    // The plate draws them as one mesh, the same triangles.
    expect(g.collision!.triangles.length).toBe(g.hulls!.reduce((n, m) => n + m.triangles.length, 0));
    const [drawn] = collisionMeshes([u], {});
    expect(drawn!.triangles.length).toBe(g.collision!.triangles.length);
    // A hole through the bar's middle leaves two halves, each wrapped on its own.
    const slot = shape('box', { size: [10, 20, 20], pos: [0, 0, -10], hole: true });
    const [cut] = robotGeometry([group([40, 10, 30], [bar, left, right, slot], { pos: [100, 0, 15] })], {}, false);
    expect(cut.hulls).toHaveLength(4);
    // One part alone, or a shape that is no group, is one hull as before.
    const [one, plain] = robotGeometry([group([40, 10, 10], [bar]), bar], {}, false);
    expect(one.hulls).toBeUndefined();
    expect(plain.hulls).toBeUndefined();
    expect(one.collision!.triangles.length).toBe(36);
  });

  it('splits a bent part into convex pieces when asked for more than one, closed or not', async () => {
    const { robotGeometry } = await import('./kernel');
    // An L, 10 mm thick: two arms 40 long and 10 wide. One hull round it fills the corner between the arms.
    const outline = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]];
    const positions = [...outline.map(([x, y]) => [x, y, 0]), ...outline.map(([x, y]) => [x, y, 10])].flat();
    const fan = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]];
    const triangles = [...fan.map(([a, b, c]) => [a, c, b]), ...fan.map(([a, b, c]) => [a + 6, b + 6, c + 6]), ...outline.map((_, i) => [i, (i + 1) % 6, ((i + 1) % 6) + 6, i, ((i + 1) % 6) + 6, i + 6])].flat();
    setAssets({ bent: meshAsset(positions, triangles), torn: meshAsset(positions, triangles.slice(3)) });
    const volumes = (g: { collision: MeshData | null; hulls?: MeshData[] }) => (g.hulls ?? (g.collision ? [g.collision] : [])).map((m) => Math.round(meshProperties(m).volume)).sort((a, b) => a - b);
    for (const asset of ['bent', 'torn']) {
      const l = imported(asset, [40, 40, 10], { pos: [100, 0, 5], rot: [0, 0, 30] });
      const [one] = robotGeometry([l], {}, false);
      expect(volumes(one)).toEqual([11500]);
      // Cut where the arms meet, however the part is turned: the two hulls are the arms, 7000 mm³ together, to within a hundredth.
      const [two] = robotGeometry([l], {}, false, { [l.id]: 2 });
      expect(volumes(two)).toHaveLength(2);
      expect(volumes(two)[0] + volumes(two)[1]).toBeLessThan(7070);
      // No more pieces than are worth it, however many are allowed.
      const [many] = robotGeometry([l], {}, false, { [l.id]: 16 });
      expect(volumes(many)).toEqual(volumes(two));
    }
    // A part that is convex already stays whole.
    const box = shape('box', { size: [20, 30, 40] });
    expect(robotGeometry([box], {}, false, { [box.id]: 8 })[0].hulls).toBeUndefined();
  });

  it('gives what a link collides as on its own, for the plate: the same hull or mesh, and nothing for a plain shape', async () => {
    const { collisionMeshes, robotGeometry } = await import('./kernel');
    const body = shape('box', { size: [20, 20, 10], pos: [0, 0, 5] });
    const wheel = shape('cylinder', { size: [10, 10, 4], pos: [15, 0, 5], rot: [90, 0, 0] });
    const ghost = shape('box', { pos: [40, 0, 5] });
    const kinds = { [body.id]: 'box', [wheel.id]: 'hull', [ghost.id]: 'none' } as const;
    const [b, w, g] = collisionMeshes([body, wheel, ghost], kinds);
    expect(b).toBeNull();
    expect(g).toBeNull();
    // The very hull the export writes.
    const exported = robotGeometry([body, wheel, ghost], kinds, false)[1].collision!;
    expect([...w!.positions]).toEqual([...exported.positions]);
    expect([...w!.triangles]).toEqual([...exported.triangles]);
    // Unset, a link collides as its hull; told to, as itself.
    expect(collisionMeshes([body], {})[0]!.triangles.length).toBe(36);
    expect(collisionMeshes([body], { [body.id]: 'mesh' })[0]!.triangles.length).toBe(36);
  });
});

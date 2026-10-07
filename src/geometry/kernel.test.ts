import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { geomKey, textAssetKey } from '../model/geomKey';
import { add, apply, emptyBounds, expandBounds, nodeMatrix } from '../model/math';
import type { Bounds } from '../model/math';
import { alignNodes, makeGroup } from '../model/ops';
import type { Asset, GroupNode, ImportNode, Polygon, SceneNode, ShapeKind, ShapeNode, TextNode, Vec3 } from '../model/types';
import { build, cacheSize, clearCache, decodeBase64, exportNodes, initKernel, measure, setAssets } from './kernel';
import type { MeshData } from './mesh';
import { defaultParams, shapeDef } from './shapes';

beforeAll(async () => {
  await initKernel();
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

// A 2 mm cube centred on the origin; vertex i sits at (bit 0, bit 1, bit 2) of i. Outward-facing triangles.
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

  it('skips hidden nodes and reports nothing as null', () => {
    const box = shape('box');
    const far = shape('box', { pos: [100, 0, 0], hidden: true });
    expectBounds(measure([box, far]), [-10, -10, -10], [10, 10, 10]);
    expect(measure([])).toBeNull();
    expect(measure([far])).toBeNull();
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
    // The lettering reaches a millimetre and a half into the top of the block.
    expect(build(geomKey(group), group).volume).toBeCloseTo(8000 - 84 * 1.5, 4);
  });

  it('says so when the outlines are missing', () => {
    const node = text({ text: 'never sent' });
    expect(() => build(geomKey(node), node)).toThrow(/no letters/);
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

  it('extrudes them 1 mm, centred', () => {
    const r = make(imported('frame', [10, 10, 1], { size: [10, 10, 5] }));
    expect(r.watertight).toBe(true);
    expect(r.volume).toBeCloseTo(100 - 16, 6);
    expectBounds(r.bounds, [-5, -5, -0.5], [5, 5, 0.5]);
  });

  it('honours the fill rule and merges shapes', () => {
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

  it('rebuilds when an asset is replaced under the same name', () => {
    const node = imported('cube', [2, 2, 2]);
    expect(make(node).volume).toBeCloseTo(8, 6);
    setAssets({ cube: meshAsset(CUBE_POSITIONS.map((v) => v * 2), CUBE_TRIANGLES) });
    expect(make(node).volume).toBeCloseTo(64, 6);
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
});

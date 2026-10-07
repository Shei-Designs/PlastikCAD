import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geomKey } from '../model/geomKey';
import { builtSize } from '../model/math';
import type { ShapeKind, ShapeNode, Vec3 } from '../model/types';
import { build, clearCache, initKernel } from './kernel';
import {
  buildShape,
  clampParams,
  defaultParams,
  inset,
  PALETTE,
  paramMax,
  polygonExtent,
  regularPolygon,
  shapeDef,
  SHAPES,
} from './shapes';

let k: ManifoldToplevel;

beforeAll(async () => {
  k = await initKernel();
});

afterAll(() => clearCache());

function shape(kind: ShapeKind, over: Partial<ShapeNode> = {}): ShapeNode {
  const def = shapeDef(kind);
  return {
    id: kind,
    name: def.name,
    type: 'shape',
    shape: kind,
    params: defaultParams(kind),
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    size: def.defaultSize,
    hole: false,
    color: def.defaultColor,
    ...over,
  };
}

const make = (node: ShapeNode) => build(geomKey(node), node);

/** Builds the node, checks that it is a closed solid filling its box exactly, and returns its volume. */
function volumeOf(node: ShapeNode): number {
  const r = make(node);
  const size = builtSize(node);
  expect(r.watertight).toBe(true);
  expect(r.triangles).toBeGreaterThan(3);
  expect(r.render.positions.length).toBe(r.triangles * 9);
  expect(r.render.normals.length).toBe(r.triangles * 9);
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(r.bounds.min[i] + size[i] / 2)).toBeLessThan(1e-3);
    expect(Math.abs(r.bounds.max[i] - size[i] / 2)).toBeLessThan(1e-3);
  }
  expect(r.volume).toBeGreaterThan(0);
  return r.volume;
}

/** Area of a regular polygon with `n` sides around a circle of radius `r` (the flats touch the circle). */
const around = (n: number, r: number) => n * Math.tan(Math.PI / n) * r * r;

describe('shape catalog', () => {
  it('lists the shapes in order', () => {
    expect(SHAPES.map((s) => s.kind)).toEqual([
      'box', 'cylinder', 'sphere', 'cone', 'pyramid', 'wedge', 'roof', 'roundroof', 'prism', 'tube', 'torus', 'dome', 'fillet',
    ]);
  });

  it('uses palette colours and sane defaults', () => {
    const colors = PALETTE.map((c) => c.value);
    expect(colors).toHaveLength(8);
    for (const def of SHAPES) {
      expect(colors).toContain(def.defaultColor);
      for (const p of def.params) {
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      }
      // The defaults are valid as they stand.
      expect(clampParams({ shape: def.kind, params: defaultParams(def.kind), size: def.defaultSize })).toEqual(
        defaultParams(def.kind),
      );
    }
  });

  it('makes the default prism a regular hexagon', () => {
    expect(shapeDef('prism').defaultSize).toEqual([20, 17.3205, 20]);
    expect(shapeDef('torus').defaultSize).toEqual([30, 30, 8]);
    expect(shapeDef('dome').defaultSize).toEqual([20, 20, 10]);
  });

  it('lays polygons out with a side facing -Y', () => {
    // A square is parallel to the axes, counter-clockwise from its +X -Y corner.
    const h = Math.SQRT1_2;
    const expected = [[h, -h], [h, h], [-h, h], [-h, -h]];
    regularPolygon(4).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(expected[i][0]);
      expect(p[1]).toBeCloseTo(expected[i][1]);
    });
    // A triangle rests on its side and points towards +Y.
    expect(Math.max(...regularPolygon(3).map((p) => p[1]))).toBeCloseTo(1);
    expect(polygonExtent(6)[0]).toBeCloseTo(2);
    expect(polygonExtent(6)[1]).toBeCloseTo(Math.sqrt(3));
    expect(polygonExtent(3)[1]).toBeCloseTo(1.5);
  });
});

describe('inset', () => {
  const square = regularPolygon(4).map(([x, y]): [number, number] => [x * 10 * Math.SQRT2, y * 5 * Math.SQRT2]);

  it('moves every side inwards', () => {
    // 20 by 10, shrunk by 2 all round.
    const inner = inset(square, 2);
    expect(inner).toHaveLength(4);
    expect(Math.max(...inner.map((p) => p[0]))).toBeCloseTo(8);
    expect(Math.min(...inner.map((p) => p[0]))).toBeCloseTo(-8);
    expect(Math.max(...inner.map((p) => p[1]))).toBeCloseTo(3);
    expect(Math.min(...inner.map((p) => p[1]))).toBeCloseTo(-3);
  });

  it('drops sides that are squeezed out, and everything in the end', () => {
    // A square with one corner cut off by a short fifth side.
    const cut: [number, number][] = [[-10, -10], [10, -10], [10, 9], [9, 10], [-10, 10]];
    expect(inset(cut, 0.1)).toHaveLength(5);
    expect(inset(cut, 5)).toHaveLength(4);
    expect(inset(square, 5)).toEqual([]);
    expect(inset(square, 8)).toEqual([]);
  });
});

describe('clampParams', () => {
  it('fills in defaults and rounds whole numbers', () => {
    expect(clampParams({ shape: 'cone', params: {}, size: [20, 20, 20] })).toEqual({ sides: 64, top: 0 });
    expect(clampParams({ shape: 'cylinder', params: { sides: 6.6 }, size: [20, 20, 20] })).toEqual({ sides: 7, radius: 0 });
    expect(clampParams({ shape: 'pyramid', params: { sides: 99 }, size: [20, 20, 20] })).toEqual({ sides: 12 });
    const cone = clampParams({ shape: 'cone', params: { sides: 2, top: 3 }, size: [20, 20, 20] });
    expect(cone).toEqual({ sides: 3, top: 0.95 });
    expect(clampParams({ shape: 'sphere', params: { sides: NaN }, size: [20, 20, 20] })).toEqual({ sides: 48 });
  });

  it('limits the edge radius to half the smallest side', () => {
    expect(clampParams({ shape: 'box', params: { radius: 9 }, size: [20, 30, 10] })).toEqual({ radius: 5 });
    expect(clampParams({ shape: 'box', params: { radius: -1 }, size: [20, 30, 10] })).toEqual({ radius: 0 });
    expect(paramMax('box', 'radius', [20, 30, 10])).toBe(5);
  });

  it('keeps the wall thinner than half the tube', () => {
    const p = clampParams({ shape: 'tube', params: { wall: 50, sides: 64 }, size: [30, 20, 10] });
    expect(p.wall).toBeLessThan(10);
    expect(p.wall).toBeGreaterThan(9);
    expect(clampParams({ shape: 'tube', params: { wall: 0, sides: 64 }, size: [30, 20, 10] }).wall).toBe(0.2);
    // On a tiny tube the size limit wins over the minimum.
    expect(clampParams({ shape: 'tube', params: { wall: 2, sides: 64 }, size: [0.2, 0.2, 5] }).wall).toBeCloseTo(0.098);
  });
});

describe('shapes', () => {
  it('builds every shape watertight, filling its box', () => {
    for (const def of SHAPES) volumeOf(shape(def.kind));
  });

  it('fits the box at any number of sides', () => {
    for (const def of SHAPES) {
      const sides = def.params.find((p) => p.key === 'sides');
      if (!sides) continue;
      for (const n of [sides.min, sides.min + 1, sides.min + 2, 9, 11, sides.max]) {
        if (n > sides.max) continue;
        volumeOf(shape(def.kind, { params: { ...defaultParams(def.kind), sides: n } }));
      }
    }
  });

  it('builds proportional shapes as a unit cube', () => {
    expect(volumeOf(shape('box'))).toBeCloseTo(1, 9);
    expect(volumeOf(shape('cylinder'))).toBeCloseTo(around(64, 0.5), 6);
    expect(volumeOf(shape('cylinder'))).toBeCloseTo(Math.PI / 4, 2);
    expect(Math.abs(volumeOf(shape('sphere')) / (Math.PI / 6) - 1)).toBeLessThan(0.02);
    expect(volumeOf(shape('cone'))).toBeCloseTo(Math.PI / 12, 2);
    expect(volumeOf(shape('pyramid'))).toBeCloseTo(1 / 3, 9);
    expect(volumeOf(shape('wedge'))).toBeCloseTo(0.5, 9);
    expect(volumeOf(shape('roof'))).toBeCloseTo(0.5, 9);
    // A hexagon covers three quarters of its bounding box.
    expect(volumeOf(shape('prism'))).toBeCloseTo(0.75, 6);
    // Half a sphere, stretched to the full height of the box.
    expect(Math.abs(volumeOf(shape('dome')) / (Math.PI / 6) - 1)).toBeLessThan(0.02);
  });

  it('leaves the fillet what a quarter-round bar does not fill', () => {
    // Sixteen chords inside the quarter circle of radius 1.
    expect(volumeOf(shape('fillet'))).toBeCloseTo(1 - 8 * Math.sin(Math.PI / 32), 5);
    // One step is a straight cut: half the bar.
    expect(volumeOf(shape('fillet', { params: { sides: 1 } }))).toBeCloseTo(0.5, 6);
    // Solid at +X +Z, hollow towards -X -Z: nothing reaches inside the quarter circle.
    const p = make(shape('fillet')).render.positions;
    for (let i = 0; i < p.length; i += 3) expect(Math.hypot(p[i] + 0.5, p[i + 2] + 0.5)).toBeGreaterThan(1 - 1e-5);
  });

  it('rounds the rims of a cylinder, keeping its box', () => {
    // The plain cylinder is built as a unit cube; scale it up to compare.
    const plain = volumeOf(shape('cylinder', { size: [20, 20, 10] })) * 20 * 20 * 10;
    const soft = volumeOf(shape('cylinder', { size: [20, 20, 10], params: { sides: 64, radius: 3 } }));
    // Less than the sharp cylinder, but more than one whose rims were chamfered flat.
    expect(soft).toBeLessThan(plain);
    const ring = Math.PI * ((10 * 10 - 7 * 7) * 6 + 2 * 3 * 3 * 7 * 2);
    expect(soft).toBeGreaterThan(plain - ring);
    // Oval, with the rounding worth the whole height: the rims meet in the middle.
    volumeOf(shape('cylinder', { size: [30, 12, 6], params: { sides: 48, radius: 3 } }));
    // The rounding never makes a cylinder a different shape as it is resized (size-dependent key).
    expect(builtSize(shape('cylinder', { size: [30, 12, 6], params: { sides: 48, radius: 3 } }))).toEqual([30, 12, 6]);
  });

  it('rounds the round roof over its flat base', () => {
    // Thirty-two chords inside a half circle of radius 1/2, stretched to twice its height.
    expect(volumeOf(shape('roundroof'))).toBeCloseTo(2 * 16 * Math.sin(Math.PI / 32) * 0.25, 5);
    const p = make(shape('roundroof')).render.positions;
    // The whole width at the bottom, only the ridge at the top.
    for (let i = 0; i < p.length; i += 3) if (p[i + 2] > 0.4999) expect(p[i]).toBeCloseTo(0);
  });

  it('keeps the corners of a twelve-sided prism sharp', () => {
    const { normals } = make(shape('prism', { params: { sides: 12 } })).render;
    // Flat shading: every corner of a side face carries that face's own normal, so the
    // horizontal normals point in exactly twelve directions.
    const directions = new Set<string>();
    for (let i = 0; i < normals.length; i += 3) {
      if (Math.abs(normals[i + 2]) < 0.5) directions.add(`${normals[i].toFixed(3)},${normals[i + 1].toFixed(3)}`);
    }
    expect(directions.size).toBe(12);
  });

  it('tapers a cone to its top size', () => {
    const v = volumeOf(shape('cone', { params: { sides: 64, top: 0.5 } }));
    // Frustum: h/3 * (A + sqrt(A*a) + a) with a = A/4.
    expect(v).toBeCloseTo((around(64, 0.5) * 1.75) / 3, 6);
  });

  it('puts the apex of an odd pyramid over the middle of its base, not of its box', () => {
    const r = make(shape('pyramid', { params: { sides: 3 } }));
    const p = r.render.positions;
    let apexY = NaN;
    for (let i = 0; i < p.length; i += 3) if (p[i + 2] > 0.49) apexY = p[i + 1];
    // The centroid of the triangle is a third of the way up from its base.
    expect(apexY).toBeCloseTo(-0.5 + 1 / 3, 5);
  });

  it('stands the wedge at -X and the ridge of the roof on the Y axis', () => {
    const top = (node: ShapeNode): number[] => {
      const p = make(node).render.positions;
      const xs: number[] = [];
      for (let i = 0; i < p.length; i += 3) if (p[i + 2] > 0.49) xs.push(p[i]);
      return xs;
    };
    const wedge = top(shape('wedge'));
    expect(wedge.length).toBeGreaterThan(0);
    for (const x of wedge) expect(x).toBeCloseTo(-0.5);
    const roof = top(shape('roof'));
    expect(roof.length).toBeGreaterThan(0);
    for (const x of roof) expect(x).toBeCloseTo(0);
  });

  it('shades flat faces flat', () => {
    const { normals } = make(shape('box')).render;
    for (let i = 0; i < normals.length; i += 3) {
      expect(Math.max(Math.abs(normals[i]), Math.abs(normals[i + 1]), Math.abs(normals[i + 2]))).toBeCloseTo(1);
    }
  });

  it('rounds the edges of a box by its radius', () => {
    const size: Vec3 = [20, 30, 10];
    const r = 3;
    const [a, b, c] = size.map((s) => s - 2 * r);
    // Core, six slabs, twelve quarter-cylinders and eight corner octants.
    const exact =
      a * b * c + 2 * r * (a * b + b * c + a * c) + Math.PI * r * r * (a + b + c) + (4 / 3) * Math.PI * r ** 3;
    const v = volumeOf(shape('box', { size, params: { radius: r } }));
    expect(v).toBeLessThan(exact);
    expect(v / exact).toBeGreaterThan(0.995);
    // Where the radius takes up a whole side, the box becomes a rounded slab.
    volumeOf(shape('box', { size, params: { radius: 5 } }));
    // A sharp box of the same size is built as a unit cube instead.
    expect(volumeOf(shape('box', { size }))).toBeCloseTo(1, 9);
  });

  it('turns a cube into a ball when the radius is too large', () => {
    const v = volumeOf(shape('box', { params: { radius: 50 } }));
    expect(Math.abs(v / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.02);
  });

  it('builds a tube with the wall it was asked for', () => {
    const v = volumeOf(shape('tube'));
    expect(v).toBeCloseTo((around(64, 10) - around(64, 8)) * 20, 3);
    const thick = volumeOf(shape('tube', { params: { wall: 5, sides: 64 } }));
    expect(thick).toBeCloseTo((around(64, 10) - around(64, 5)) * 20, 3);
  });

  it('keeps the wall of an oval tube the same on both axes', () => {
    const garbage: { delete(): void }[] = [];
    const keep = <T extends { delete(): void }>(o: T): T => {
      garbage.push(o);
      return o;
    };
    try {
      const node = shape('tube', { size: [30, 20, 10], params: { wall: 2, sides: 64 } });
      const tube = buildShape(k, node, keep);
      // A thin stick from the centre outwards crosses the wall once: the piece left is as long as the wall is thick.
      const crossing = (stick: Manifold): number => keep(tube.intersect(keep(stick))).volume() / (0.01 * 1);
      expect(crossing(k.Manifold.cube([40, 0.01, 1], true).translate([20, 0, 0]))).toBeCloseTo(2, 2);
      expect(crossing(k.Manifold.cube([0.01, 40, 1], true).translate([0, 20, 0]))).toBeCloseTo(2, 2);
      expect(crossing(k.Manifold.cube([0.01, 40, 1], true).translate([0, -20, 0]))).toBeCloseTo(2, 2);
    } finally {
      for (const o of garbage) o.delete();
    }
  });

  it('gives a tube with few sides an even wall', () => {
    // Triangle 20 wide and 20 deep: offsetting each side inwards by 2 leaves a similar triangle.
    const v = volumeOf(shape('tube', { params: { wall: 2, sides: 3 } }));
    const inradius = 400 / (20 + 2 * Math.hypot(10, 20));
    const outer = 200;
    const inner = outer * ((inradius - 2) / inradius) ** 2;
    expect(v).toBeCloseTo((outer - inner) * 20, 2);
    // Too thick a wall for the shape just closes the bore.
    expect(volumeOf(shape('tube', { params: { wall: 8, sides: 3 } }))).toBeCloseTo(outer * 20, 3);
  });

  it('builds a torus from its width and height', () => {
    const v = volumeOf(shape('torus'));
    const exact = 2 * Math.PI ** 2 * 11 * 16;
    expect(v).toBeLessThan(exact);
    expect(v / exact).toBeGreaterThan(0.97);
    // Oval: the ring is stretched along Y.
    const oval = volumeOf(shape('torus', { size: [30, 20, 8] }));
    expect(oval).toBeCloseTo((v * 2) / 3, 3);
  });

  it('closes the hole of a torus that is too tall for its width', () => {
    const tall = volumeOf(shape('torus', { size: [20, 20, 16] }));
    // Pappus: an ellipse (5 by 8) swept around at radius 5.
    const exact = 2 * Math.PI * 5 * Math.PI * 5 * 8;
    expect(tall / exact).toBeGreaterThan(0.97);
    expect(tall).toBeLessThan(exact);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geomKey } from '../model/geomKey';
import { builtSize } from '../model/math';
import type { ShapeKind, ShapeNode, Vec3 } from '../model/types';
import { build, clearCache, initKernel } from './kernel';
import {
  buildShape,
  clampParams,
  defaultParams,
  PALETTE,
  paramMax,
  polygonExtent,
  regularPolygon,
  shapeDef,
  SHAPES,
} from './shapes';

beforeAll(async () => {
  await initKernel();
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
      'box', 'cylinder', 'sphere', 'cone', 'pyramid', 'wedge', 'roof', 'roundroof', 'prism', 'torus', 'dome', 'fillet',
    ]);
  });

  it('uses palette colors and sane defaults', () => {
    const colors = PALETTE.map((c) => c.value);
    // Eleven colors and the custom swatch make the one row the inspector shows.
    expect(colors).toHaveLength(11);
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

  it('keeps the rounded cylinder whole when the radius takes up a whole side', () => {
    // Radius worth the whole box: a ball, not the nothing that a tube around a point used to be.
    const ball = volumeOf(shape('cylinder', { size: [20, 20, 20], params: { sides: 64, radius: 10 } }));
    expect(Math.abs(ball / ((4 / 3) * Math.PI * 1000) - 1)).toBeLessThan(0.02);
    // Worth the width only: a bar with round ends, its rims rounded. That is a flat 10 by 20 plate
    // (the core, standing up) grown by a ball of radius 5: Steiner's formula gives its volume.
    const bar = volumeOf(shape('cylinder', { size: [10, 20, 30], params: { sides: 64, radius: 5 } }));
    const exact = 2 * 10 * 20 * 5 + (Math.PI * 25 * 60) / 2 + (4 / 3) * Math.PI * 125;
    expect(bar).toBeLessThan(exact);
    expect(bar / exact).toBeGreaterThan(0.99);
    volumeOf(shape('cylinder', { size: [20, 10, 30], params: { sides: 64, radius: 5 } }));
    volumeOf(shape('cylinder', { size: [30, 12, 6], params: { sides: 48, radius: 6 } }));
    // Nothing jumps as the radius reaches its limit.
    for (const size of [[20, 20, 20], [10, 20, 30], [30, 12, 6]] as Vec3[]) {
      const max = paramMax('cylinder', 'radius', size);
      const whole = volumeOf(shape('cylinder', { size, params: { sides: 64, radius: max } }));
      const nearly = volumeOf(shape('cylinder', { size, params: { sides: 64, radius: max - 0.01 } }));
      expect(Math.abs(whole / nearly - 1)).toBeLessThan(0.01);
    }
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


  it('builds a torus from its width and height', () => {
    const v = volumeOf(shape('torus'));
    const exact = 2 * Math.PI ** 2 * 11 * 16;
    expect(v).toBeLessThan(exact);
    expect(v / exact).toBeGreaterThan(0.97);
  });

  it('keeps the ring of an oval torus as wide at its ends as along its sides', async () => {
    const k = await initKernel();
    /** How far in the ring reaches from the rim along +X and +Y, on the middle plane: the two ends of the oval and its sides. */
    const widths = (node: ShapeNode): [number, number] => {
      const kept: { delete(): void }[] = [];
      const m = buildShape(k, node, (o) => (kept.push(o), o));
      const positions = m.getMesh().vertProperties;
      let [x, y] = [Infinity, Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        if (Math.abs(positions[i + 2]) > 1e-4) continue;
        if (Math.abs(positions[i + 1]) < 1e-4 && positions[i] > 0) x = Math.min(x, positions[i]);
        if (Math.abs(positions[i]) < 1e-4 && positions[i + 1] > 0) y = Math.min(y, positions[i + 1]);
      }
      const genus = m.genus();
      for (const o of kept) o.delete();
      expect(genus).toBe(1);
      return [node.size[0] / 2 - x, node.size[1] / 2 - y];
    };
    // A set ring width, the same both ways; stretched from a round torus it would be 4 and 2.67.
    const [atEnds, atSides] = widths(shape('torus', { size: [30, 20, 8], params: { sides: 48, ring: 4 } }));
    expect(atEnds).toBeCloseTo(4, 3);
    expect(atSides).toBeCloseTo(4, 3);
    // A round section: as wide as the torus is tall along the sides. That is wider than the ends of this oval turn
    // (a radius of 6.67), so the hole comes to a point there, a little further in than the width, on the long axis.
    const round = widths(shape('torus', { size: [30, 20, 8] }));
    expect(round[1]).toBeCloseTo(8, 3);
    expect(round[0]).toBeCloseTo(15 - (Math.sqrt(1 - (144 - 100) / 125) * 125) / 15, 3);
    // The section carried round the middle of the ring (Pappus): 2 by 4, along the outline less a turn of radius 2.
    const outline = Math.PI * (3 * (15 + 10) - Math.sqrt((3 * 15 + 10) * (15 + 3 * 10)));
    const exact = Math.PI * 2 * 4 * (outline - 2 * Math.PI * 2);
    const v = volumeOf(shape('torus', { size: [30, 20, 8], params: { sides: 48, ring: 4 } }));
    expect(v).toBeLessThan(exact);
    expect(v / exact).toBeGreaterThan(0.97);
    // Turned a quarter, it is the same ring.
    expect(volumeOf(shape('torus', { size: [20, 30, 8], params: { sides: 48, ring: 4 } }))).toBeCloseTo(v, 3);
  });

  it('builds a long oval whose ring is wider than its ends turn, with the width kept along its sides', async () => {
    // 60 by 20 turns with a radius of 3.3 mm at its ends; the ring is 8 wide.
    const long = shape('torus', { size: [60, 20, 8], params: { sides: 48, ring: 8 } });
    const k = await initKernel();
    const kept: { delete(): void }[] = [];
    const m = buildShape(k, long, (o) => (kept.push(o), o));
    expect(m.status()).toBe('NoError');
    expect(m.genus()).toBe(1);
    const { min, max } = m.boundingBox();
    expect([max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((x) => +x.toFixed(4))).toEqual([60, 20, 8]);
    const positions = m.getMesh().vertProperties;
    let side = Infinity;
    for (let i = 0; i < positions.length; i += 3) if (Math.abs(positions[i]) < 1e-4 && Math.abs(positions[i + 2]) < 1e-4 && positions[i + 1] > 0) side = Math.min(side, positions[i + 1]);
    expect(10 - side).toBeCloseTo(8, 3);
    const volume = m.volume();
    for (const o of kept) o.delete();
    // Less than the section carried all the way round would make, since the sections overlap at the ends, and more than half of it.
    const outline = Math.PI * (3 * (30 + 10) - Math.sqrt((3 * 30 + 10) * (30 + 3 * 10)));
    const swept = Math.PI * 4 * 4 * (outline - 2 * Math.PI * 4);
    expect(volume).toBeLessThan(swept);
    expect(volume).toBeGreaterThan(swept / 2);
    // The hole closes across the narrow way at the same ring width as a round torus of that width would.
    expect(paramMax('torus', 'ring', [60, 20, 8])).toBe(10);
    expect(volumeOf(shape('torus', { size: [60, 20, 8], params: { sides: 48, ring: 10 } }))).toBeCloseTo(volumeOf(shape('torus', { size: [60, 20, 8], params: { sides: 48, ring: 40 } })), 6);
  });

  it('sets the width of the ring, and so the hole, by the ring width', () => {
    // Pappus: a 4 wide by 8 tall ellipse swept at radius 13, so the hole is 30 - 2 * 4 = 22 across.
    const thin = volumeOf(shape('torus', { params: { ring: 4 } }));
    const exact = 2 * Math.PI * 13 * Math.PI * 2 * 4;
    expect(thin / exact).toBeGreaterThan(0.97);
    expect(thin).toBeLessThan(exact);
    // A ring wider than half the width closes the hole and is clamped there.
    expect(paramMax('torus', 'ring', [30, 30, 8])).toBe(15);
    const closed = volumeOf(shape('torus', { params: { ring: 15 } }));
    expect(closed).toBeCloseTo(volumeOf(shape('torus', { params: { ring: 40 } })), 6);
    expect(closed).toBeGreaterThan(thin);
  });

  it('hands a solid that came out wrong over to be freed, rather than leaving it in the kernel', async () => {
    const k = await initKernel();
    const kept: { delete(): void }[] = [];
    const keep = <T extends { delete(): void }>(o: T): T => {
      kept.push(o);
      return o;
    };
    // A size that is not a number puts every point of the mesh nowhere.
    expect(() => buildShape(k, shape('torus', { size: [Number.NaN, 30, 8] }), keep)).toThrow(/Geometry kernel error/);
    expect(kept).toHaveLength(1);
    for (const o of kept) o.delete();
  });

  it('closes the hole of a torus that is too tall for its width', () => {
    const tall = volumeOf(shape('torus', { size: [20, 20, 16] }));
    // Pappus: an ellipse (5 by 8) swept around at radius 5.
    const exact = 2 * Math.PI * 5 * Math.PI * 5 * 8;
    expect(tall / exact).toBeGreaterThan(0.97);
    expect(tall).toBeLessThan(exact);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geomKey } from '../model/geomKey';
import { builtSize } from '../model/math';
import type { GroupNode, SceneNode, ShapeKind, ShapeNode, Vec3 } from '../model/types';
import { fitCircle, indexFeatures, nearestFeature, quadrantsOf } from './features';
import type { FeatureIndex, FeatureKind } from './features';
import { build, clearCache, initKernel } from './kernel';
import { defaultParams, shapeDef } from './shapes';

beforeAll(async () => {
  await initKernel();
});
afterAll(() => clearCache());

let nextId = 1;
const base = (name: string) => ({ id: `n${nextId++}`, name, pos: [0, 0, 0] as Vec3, rot: [0, 0, 0] as Vec3, hole: false, color: '#8fa3bf' });
function shape(kind: ShapeKind, over: Partial<ShapeNode> = {}): ShapeNode {
  const def = shapeDef(kind);
  return { ...base(def.name), type: 'shape', shape: kind, params: defaultParams(kind), size: def.defaultSize, ...over };
}
function group(natural: Vec3, children: SceneNode[]): GroupNode {
  return { ...base('Group'), type: 'group', natural, size: natural, children };
}
/** The features of a node as placed: the kernel builds shapes at unit size, so the mesh is scaled up to the node's size first. */
const indexOf = async (node: SceneNode): Promise<FeatureIndex> => {
  const positions = (await build(geomKey(node), node)).render.positions.slice();
  const built = builtSize(node);
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] *= node.size[k] / built[k];
  return indexFeatures(positions);
};
const ALL = new Set<FeatureKind>(['point', 'middle', 'edge', 'face', 'circle', 'quadrant', 'facecenter', 'center']);
const near = (a: Vec3, b: Vec3, digits = 3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('indexFeatures', () => {
  it('reads a box as six faces, twelve edges and eight corners, centred on itself', async () => {
    const index = await indexOf(shape('box', { size: [20, 10, 5] }));
    expect(index.regions).toHaveLength(6);
    expect(index.regions.every((r) => r.flat)).toBe(true);
    expect(index.regions.map((r) => Math.round(r.area)).sort((a, b) => a - b)).toEqual([50, 50, 100, 100, 200, 200]);
    expect(index.edges).toHaveLength(12);
    expect(index.points).toHaveLength(8);
    expect(index.circles).toHaveLength(0);
    near(index.mass!, [0, 0, 0]);
    near(index.box, [0, 0, 0]);
    near(index.center, [0, 0, 0]);
    const lengths = index.edges.map((e) => Math.round(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]))).sort((a, b) => a - b);
    expect(lengths).toEqual([5, 5, 5, 5, 10, 10, 10, 10, 20, 20, 20, 20]);
  });

  it('reads a cylinder as two circles, two flat caps and one curved surface', async () => {
    const index = await indexOf(shape('cylinder', { size: [10, 10, 20] }));
    expect(index.circles).toHaveLength(2);
    for (const c of index.circles) {
      // The kernel's circle is a polygon a hair outside the radius.
      expect(c.radius).toBeCloseTo(5, 1);
      expect(c.sweep).toBe(360);
      expect(Math.abs(c.normal[2])).toBeCloseTo(1, 6);
      expect(Math.abs(c.center[2])).toBeCloseTo(10, 3);
    }
    expect(index.regions).toHaveLength(3);
    expect(index.regions.filter((r) => r.flat)).toHaveLength(2);
    expect(index.regions.find((r) => !r.flat)!.area).toBeCloseTo(2 * Math.PI * 5 * 20, -1);
    expect(index.edges).toHaveLength(0);
    expect(index.points).toHaveLength(0);
  });

  it('finds the round hole through a box as circles, and leaves the box its own edges', async () => {
    const index = await indexOf(group([30, 20, 6], [shape('box', { size: [30, 20, 6] }), shape('cylinder', { size: [8, 8, 10], hole: true })]));
    expect(index.circles).toHaveLength(2);
    for (const c of index.circles) {
      expect(c.radius).toBeCloseTo(4, 2);
      expect(c.center[0]).toBeCloseTo(0, 3);
      expect(c.center[1]).toBeCloseTo(0, 3);
    }
    expect(index.edges).toHaveLength(12);
    expect(index.points).toHaveLength(8);
    // The top is one face with a hole in it: the area of the slab less the hole.
    const top = index.regions.find((r) => r.flat && r.normal[2] > 0.99)!;
    expect(top.area).toBeCloseTo(30 * 20 - Math.PI * 16, 0);
  });
});

describe('nearestFeature', () => {
  it('takes the corner, the edge, its middle or the face by what is nearest and wanted', async () => {
    const index = await indexOf(shape('box', { size: [20, 10, 5] }));
    const top = index.regions.findIndex((r) => r.normal[2] > 0.99);
    const topTriangle = index.regionOf.findIndex((r) => r === top);
    const corner = nearestFeature(index, 'b', [9.8, 4.9, 2.5], topTriangle, ALL, 1);
    expect(corner?.kind).toBe('point');
    near((corner as { at: Vec3 }).at, [10, 5, 2.5]);
    // At the middle of the front top edge both the edge and its middle are within reach; the middle, a point, wins.
    const middle = nearestFeature(index, 'b', [0.2, -5, 2.5], topTriangle, ALL, 1);
    expect(middle?.kind).toBe('middle');
    const edge = nearestFeature(index, 'b', [0.2, -5, 2.5], topTriangle, new Set<FeatureKind>(['edge', 'face']), 1);
    expect(edge?.kind).toBe('edge');
    const face = nearestFeature(index, 'b', [3, 1, 2.5], topTriangle, ALL, 1);
    expect(face?.kind).toBe('face');
    if (face?.kind === 'face') {
      expect(face.flat).toBe(true);
      expect(face.area).toBeCloseTo(200, 3);
      near(face.normal, [0, 0, 1]);
    }
    expect(nearestFeature(index, 'b', [3, 1, 2.5], topTriangle, new Set<FeatureKind>(['point']), 1)).toBeNull();
  });

  it('snaps to the centre of a flat face, but not of a curved one', async () => {
    const index = await indexOf(shape('box', { size: [20, 10, 5] }));
    const top = index.regions.findIndex((r) => r.normal[2] > 0.99);
    const topTriangle = index.regionOf.findIndex((r) => r === top);
    const centre = nearestFeature(index, 'b', [0.3, 0.2, 2.5], topTriangle, ALL, 1);
    expect(centre?.kind).toBe('facecenter');
    near((centre as { at: Vec3 }).at, [0, 0, 2.5]);
    // The surface's hover alone reads it as the face, when face centres are off.
    expect(nearestFeature(index, 'b', [0.3, 0.2, 2.5], topTriangle, new Set<FeatureKind>(['face']), 1)?.kind).toBe('face');
    const round = await indexOf(shape('cylinder', { size: [10, 10, 20] }));
    const side = round.regions.findIndex((r) => !r.flat);
    expect(nearestFeature(round, 'c', [5, 0, 0], round.regionOf.findIndex((r) => r === side), new Set<FeatureKind>(['facecenter']), 1)).toBeNull();
  });

  it('snaps to the quadrants of a circle before its rim', async () => {
    const index = await indexOf(shape('cylinder', { size: [10, 10, 20] }));
    const quadrant = nearestFeature(index, 'c', [4.9, 0.1, 10], 0, ALL, 1);
    expect(quadrant?.kind).toBe('quadrant');
    near((quadrant as { at: Vec3 }).at, [5, 0, 10], 1);
    // Between quadrants the rim itself is taken.
    expect(nearestFeature(index, 'c', [5 * Math.SQRT1_2, 5 * Math.SQRT1_2, 10], 0, ALL, 1)?.kind).toBe('circle');
  });

  it('takes a circle by its rim and reports the curved side as a surface', async () => {
    const index = await indexOf(shape('cylinder', { size: [10, 10, 20] }));
    const rim = nearestFeature(index, 'c', [5 * Math.cos(0.5), 5 * Math.sin(0.5), 9.9], 0, ALL, 1);
    expect(rim?.kind).toBe('circle');
    if (rim?.kind === 'circle') expect(rim.radius).toBeCloseTo(5, 1);
    const curved = index.regions.findIndex((r) => !r.flat);
    const side = nearestFeature(index, 'c', [5, 0, 0], index.regionOf.findIndex((r) => r === curved), ALL, 1);
    expect(side?.kind).toBe('face');
    if (side?.kind === 'face') expect(side.flat).toBe(false);
  });
});

describe('fitCircle', () => {
  it('fits an arc through points on a circle and measures its sweep', () => {
    const pts: Vec3[] = Array.from({ length: 9 }, (_, i) => {
      const a = (Math.PI / 2) * (i / 8);
      return [3 + 10 * Math.cos(a), -2 + 10 * Math.sin(a), 4];
    });
    const arc = fitCircle(pts, false)!;
    expect(arc.radius).toBeCloseTo(10, 6);
    near(arc.center, [3, -2, 4], 6);
    expect(arc.sweep).toBeCloseTo(90, 6);
    expect(Math.abs(arc.normal[2])).toBeCloseTo(1, 6);
    expect(arc.ends).toEqual([pts[0], pts[8]]);
  });

  it('gives four quadrants for a circle square to an axis, and only those an arc reaches', () => {
    const circle = { center: [1, 2, 3] as Vec3, normal: [0, 0, 1] as Vec3, radius: 5, sweep: 360, ends: null };
    const quads = quadrantsOf(circle).map((q) => q.map((v) => Math.round(v * 1e6) / 1e6));
    expect(quads).toHaveLength(4);
    expect(quads).toEqual(expect.arrayContaining([[6, 2, 3], [-4, 2, 3], [1, 7, 3], [1, -3, 3]]));
    // A circle tilted off every axis meets each axis' shadow: six points.
    const t = 1 / Math.sqrt(3);
    expect(quadrantsOf({ ...circle, normal: [t, t, t] })).toHaveLength(6);
    // A quarter arc from +X round to +Y reaches only those two.
    const arc = { ...circle, sweep: 90, ends: [[6, 2, 3], [1, 7, 3]] as [Vec3, Vec3] };
    expect(quadrantsOf(arc).map((q) => q.map((v) => Math.round(v * 1e6) / 1e6))).toEqual(expect.arrayContaining([[6, 2, 3], [1, 7, 3]]));
    expect(quadrantsOf(arc)).toHaveLength(2);
  });

  it('refuses points that are not on one circle', () => {
    expect(fitCircle([[0, 0, 0], [10, 0, 0], [20, 0, 0]], false)).toBeNull();
    expect(fitCircle([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [5, 5, 0]], true)).toBeNull();
  });
});

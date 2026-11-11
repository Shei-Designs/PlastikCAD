import { describe, expect, it } from 'vitest';
import { closestBetweenSegments, describe as describeFeature, measure } from './measure';
import type { Feature } from './features';

const point = (at: [number, number, number], kind: 'point' | 'middle' | 'quadrant' | 'facecenter' | 'center' = 'point'): Feature => ({ kind, node: 'n', at });
const edge = (a: [number, number, number], b: [number, number, number]): Feature => ({ kind: 'edge', node: 'n', a, b });
const face = (at: [number, number, number], normal: [number, number, number], flat = true): Feature => ({ kind: 'face', node: 'n', at, normal, center: at, area: 100, flat, region: 0 });
const circle = (center: [number, number, number], radius: number, normal: [number, number, number] = [0, 0, 1]): Feature => ({ kind: 'circle', node: 'n', center, normal, radius, sweep: 360, ends: null });

describe('describe', () => {
  it('says what one feature is', () => {
    expect(describeFeature(point([1, 2, 3])).lines).toEqual(['Point', '(1, 2, 3)']);
    expect(describeFeature(point([1, 2, 3], 'center')).text).toBe('Object center');
    expect(describeFeature(edge([0, 0, 0], [30, 40, 0])).lines[0]).toBe('Edge 50 mm');
    expect(describeFeature(circle([0, 0, 0], 5)).lines).toEqual(['Circle Ø 10 mm', 'R 5 mm', 'center (0, 0, 0)']);
    expect(describeFeature({ ...(circle([0, 0, 0], 5) as Extract<Feature, { kind: 'circle' }>), sweep: 90, ends: [[5, 0, 0], [0, 5, 0]] }).lines[0]).toBe('Arc R 5 mm, 90°');
    expect(describeFeature(face([0, 0, 0], [0, 0, 1])).lines[0]).toBe('Face 100 mm²');
    expect(describeFeature(face([0, 0, 0], [0, 0, 1], false)).lines[0]).toBe('Surface 100 mm²');
  });
});

describe('measure', () => {
  it('gives the distance between points, with the parts along each axis', () => {
    const m = measure(point([0, 0, 0]), point([3, 4, 0], 'facecenter'));
    expect(m.lines).toEqual(['Distance 5 mm', 'X 3 mm · Y 4 mm']);
    expect(m.text).toBe('5 mm');
    expect(m.to).toEqual([3, 4, 0]);
    // Along one axis only, the parts say nothing new.
    expect(measure(point([0, 0, 0]), point([0, 0, 7.5])).lines).toEqual(['Distance 7.5 mm']);
  });

  it('measures a point to an edge and to a face by the nearest point', () => {
    const toEdge = measure(point([5, 3, 0]), edge([0, 0, 0], [10, 0, 0]));
    expect(toEdge.lines[0]).toBe('To the edge 3 mm');
    expect(toEdge.to).toEqual([5, 0, 0]);
    // Past the end of the edge, the end is the nearest point.
    expect(measure(point([14, 3, 0]), edge([0, 0, 0], [10, 0, 0])).text).toBe('5 mm');
    const toFace = measure(face([0, 0, 10], [0, 0, 1]), point([2, 2, 4]));
    expect(toFace.lines).toEqual(['To the face 6 mm']);
    expect(toFace.to).toEqual([2, 2, 10]);
  });

  it('gives the angle between edges, and the gap between parallel ones', () => {
    expect(measure(edge([0, 0, 0], [10, 0, 0]), edge([0, 0, 0], [0, 10, 0])).text).toBe('90°');
    const slant = measure(edge([0, 0, 0], [10, 0, 0]), edge([0, 0, 0], [10, 10, 0]));
    expect(slant.lines).toEqual(['Angle 45° (135°)']);
    // Skew edges: the angle and how close they come.
    const skew = measure(edge([0, 0, 0], [10, 0, 0]), edge([5, -5, 2], [5, 5, 2]));
    expect(skew.lines).toEqual(['Angle 90°', 'nearest 2 mm apart']);
    expect(skew.from).toEqual([5, 0, 0]);
    expect(skew.to).toEqual([5, 0, 2]);
    expect(measure(edge([0, 0, 0], [10, 0, 0]), edge([0, 4, 0], [10, 4, 0])).lines[0]).toBe('Parallel, apart 4 mm');
  });

  it('gives the angle between faces, or their distance when parallel', () => {
    expect(measure(face([0, 0, 0], [0, 0, 1]), face([0, 0, 0], [1, 0, 0])).lines).toEqual(['Angle 90°']);
    expect(measure(face([0, 0, 0], [0, 0, 1]), face([0, 0, 0], [0, Math.SQRT1_2, Math.SQRT1_2])).text).toBe('45° (135°)');
    const apart = measure(face([0, 0, 0], [0, 0, 1]), face([5, 5, 12], [0, 0, -1]));
    expect(apart.lines).toEqual(['Parallel, 12 mm apart']);
  });

  it('gives an edge its angle to a face', () => {
    const tilted = measure(edge([0, 0, 0], [10, 0, 10]), face([0, 0, 0], [0, 0, 1]));
    expect(tilted.lines).toEqual(['Angle to the face 45°', 'to its normal 45°']);
    const along = measure(face([0, 0, 0], [0, 0, 1]), edge([0, 0, 3], [10, 0, 3]));
    expect(along.lines).toEqual(['Along the face, 3 mm off it']);
    expect(along.to).toEqual([5, 0, 0]);
  });

  it('treats circles as their centres, and says how their axes lie', () => {
    const m = measure(circle([0, 0, 0], 5), circle([20, 0, 0], 3, [1, 0, 0]));
    expect(m.lines).toEqual(['Centers 20 mm', 'axes 90° apart']);
    expect(measure(circle([0, 0, 0], 5), circle([0, 0, 8], 5)).lines).toEqual(['Centers 8 mm']);
    expect(measure(circle([0, 0, 0], 5), point([0, 0, 8])).text).toBe('8 mm');
  });
});

describe('closestBetweenSegments', () => {
  it('finds the nearest points of crossing, skew and parallel segments', () => {
    expect(closestBetweenSegments([0, 0, 0], [10, 0, 0], [5, -5, 0], [5, 5, 0])).toEqual({ p: [5, 0, 0], q: [5, 0, 0] });
    expect(closestBetweenSegments([0, 0, 0], [10, 0, 0], [12, -5, 0], [12, 5, 0])).toEqual({ p: [10, 0, 0], q: [12, 0, 0] });
    const { p, q } = closestBetweenSegments([0, 0, 0], [10, 0, 0], [0, 3, 0], [10, 3, 0]);
    expect(q[1] - p[1]).toBeCloseTo(3, 9);
    expect(q[0]).toBeCloseTo(p[0], 9);
  });
});

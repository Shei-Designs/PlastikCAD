import { describe, expect, it } from 'vitest';
import type { ShapeNode } from '../model/types';
import { collisionPrimitive, primitiveMesh, shapeInOwn } from './collision';

const node = (over: Partial<ShapeNode>): ShapeNode => ({ id: 'a', name: 'A', type: 'shape', shape: 'box', params: {}, hole: false, color: '#888888', pos: [0, 0, 0], rot: [0, 0, 0], size: [20, 20, 20], ...over });
const round = (v: number[]) => v.map((x) => +x.toFixed(3));
/** The box around a mesh's points. */
const boundsOfPositions = (p: Float32Array): { min: number[]; max: number[] } => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  p.forEach((v, i) => {
    min[i % 3] = Math.min(min[i % 3], v);
    max[i % 3] = Math.max(max[i % 3], v);
  });
  return { min, max };
};

describe('the primitive a link collides as', () => {
  it("is the object's box, a cylinder along its own Z or a ball, each filling the box", () => {
    const n = node({ size: [10, 20, 30], pos: [5, 6, 7], rot: [0, 0, 90] });
    expect(collisionPrimitive(n, { collision: 'box' })).toEqual({ shape: { box: [10, 20, 30] }, at: [5, 6, 7], rot: [0, 0, 90] });
    expect(collisionPrimitive(n, { collision: 'cylinder' }).shape).toEqual({ cylinder: { radius: 10, length: 30 } });
    expect(collisionPrimitive(n, { collision: 'sphere' }).shape).toEqual({ sphere: { radius: 15 } });
  });

  it('lays a fitted cylinder along the axis the object is round about', () => {
    // A roller lying along X, and a wheel whose axle is its own Y: the drawn cylinder fills the object's box.
    for (const size of [[60, 20, 20], [40, 8, 40], [20, 20, 50]] as [number, number, number][]) {
      for (const rot of [[0, 0, 0], [0, 0, 30], [20, 40, 60]] as [number, number, number][]) {
        const n = node({ size, rot, pos: [5, 6, 7] });
        const p = collisionPrimitive(n, { collision: 'cylinder' });
        const length = size[0] === size[1] ? size[2] : size[1] === size[2] ? size[0] : size[1];
        expect(p.shape).toEqual({ cylinder: { radius: (size[0] === size[1] ? size[0] : size[2]) / 2, length } });
        // Turned back into the object's frame, the cylinder's box is the object's.
        const flat = collisionPrimitive({ ...n, rot: [0, 0, 0], pos: [0, 0, 0] }, { collision: 'cylinder' });
        const b = boundsOfPositions(primitiveMesh(flat).positions);
        expect(round(b.max.map((v, i) => v - b.min[i]))).toEqual(size);
        if (rot.every((r) => r === 0)) expect(p.rot).toEqual(flat.rot);
      }
    }
    // Round about none: along its own Z, as wide as the wider of the two others.
    expect(collisionPrimitive(node({ size: [10, 20, 30], rot: [0, 0, 90] }), { collision: 'cylinder' })).toEqual({ shape: { cylinder: { radius: 10, length: 30 } }, at: [0, 0, 0], rot: [0, 0, 90] });
  });

  it('is the shape the link keeps for itself where it has one, in the object\'s own frame', () => {
    // A ball under the end of a leg, wider than the leg: 100 mm down the leg's own Z from its middle.
    const leg = node({ size: [10, 10, 200], pos: [50, 0, 100] });
    const foot = { collision: 'sphere' as const, shape: { size: [40, 40, 40] as [number, number, number], center: [0, 0, -100] as [number, number, number], rot: [0, 0, 0] as [number, number, number] } };
    expect(collisionPrimitive(leg, foot)).toEqual({ shape: { sphere: { radius: 20 } }, at: [50, 0, 0], rot: [0, 0, 0] });
    // The leg laid along X: the ball goes with its end.
    const laid = collisionPrimitive({ ...leg, rot: [0, 90, 0] }, foot);
    expect(round(laid.at)).toEqual([-50, 0, 100]);
    // Mirrored across its own Z, the end is the other one.
    expect(round(collisionPrimitive({ ...leg, flip: [false, false, true] }, foot).at)).toEqual([50, 0, 200]);
    // Back and forth: a box given in the design is kept in the object's frame, and comes out where it was given.
    const turned = node({ size: [30, 30, 30], pos: [10, 20, 30], rot: [0, 0, 90] });
    const kept = shapeInOwn(turned, { box: [4, 6, 8] }, [1, 0, 0, 0, 1, 0, 0, 0, 1, 12, 20, 35]);
    expect(kept).toEqual({ size: [4, 6, 8], center: [0, -2, 5], rot: [0, 0, -90] });
    const back = collisionPrimitive(turned, { collision: 'box', shape: kept });
    expect(round(back.at)).toEqual([12, 20, 35]);
    expect(round(back.rot)).toEqual([0, 0, 0]);
  });

  it('is drawn where it stands and turned as it is', () => {
    // A quarter turn about Z lays the box's 10 along Y and its 20 along X.
    const n = node({ size: [10, 20, 30], pos: [5, 6, 7], rot: [0, 0, 90] });
    const box = boundsOfPositions(primitiveMesh(collisionPrimitive(n, { collision: 'box' })).positions);
    expect(round(box.min)).toEqual([-5, 1, -8]);
    expect(round(box.max)).toEqual([15, 11, 22]);
    const ball = boundsOfPositions(primitiveMesh(collisionPrimitive(n, { collision: 'sphere' })).positions);
    expect(round(ball.min)).toEqual([-10, -9, -8]);
    expect(round(ball.max)).toEqual([20, 21, 22]);
    // A cylinder turned onto its side lies along X.
    const lying = boundsOfPositions(primitiveMesh(collisionPrimitive(node({ size: [10, 10, 40], rot: [0, 90, 0] }), { collision: 'cylinder' })).positions);
    expect(round(lying.min)).toEqual([-20, -5, -5]);
    expect(round(lying.max)).toEqual([20, 5, 5]);
  });
});
